/**
 * Host half of the SSH-remote plugin.
 *
 * Responsibilities
 *  - Persist SSH host definitions and the remote workspaces (host + absolute
 *    remote directory) the operator created.
 *  - Own one long-lived `ssh -T <host> dsh --profile acp` child per connected
 *    host and speak the Agent Client Protocol (newline-delimited JSON-RPC 2.0)
 *    to the headless DSH runtime on the far side.
 *  - Expose every operation over one small JSON-RPC-ish HTTP route so the
 *    Client half can drive it, and (optionally) as agent tools.
 *
 * Nothing here imports a `@deepseek-ai/*` package: a profile-installed bundle
 * resolves modules from the profile directory, which does not contain the dsh
 * installation's node_modules. Only Node builtins are used.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function log(...args) {
  // Never write to stdout: the Host process may own a protocol stream.
  try {
    process.stderr.write('[ssh-remotes] ' + args.map(String).join(' ') + '\n');
  } catch {
    /* ignore */
  }
}

function nowMs() {
  return Date.now();
}

function shortId(prefix) {
  return prefix + '-' + randomUUID().slice(0, 8);
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.homedir(), '.dsh');
}

function fail(message, details) {
  const error = new Error(message);
  if (details !== undefined) error.details = details;
  return error;
}

/**
 * Tool results must be lossless JSON: the executor rejects `undefined`, and
 * optional fields such as `error`/`agentInfo` are legitimately absent.
 */
function toLossless(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

const STATE_VERSION = 1;

/** Upper bound on an operator-supplied remote workspace label. */
const WORKSPACE_NAME_MAX = 80;

class Store {
  constructor(file) {
    this.file = file;
    this.state = { version: STATE_VERSION, hosts: [], workspaces: [] };
    this.reload();
  }

  /**
   * Read the config file into memory.
   *
   * The file is shared by every writer in the process — during development a
   * reload mounts a fresh plugin generation while an older one may still be
   * alive — so an in-memory snapshot is never authoritative for long. Reading
   * before every write is what keeps one writer from persisting a stale list
   * over another's records.
   */
  reload() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.state = {
          version: STATE_VERSION,
          hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [],
          workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        };
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') log('state read failed:', error.message);
    }
    return this.state;
  }

  /**
   * The only write path: refresh from disk, apply one mutation, persist.
   * A throw from `mutate` aborts before anything is written — and the
   * in-memory state is re-read from disk, because `mutate` may have already
   * half-applied its changes to the live object before throwing.
   */
  update(mutate) {
    const state = this.reload();
    let result;
    try {
      result = mutate(state);
    } catch (error) {
      this.reload();
      throw error;
    }
    this.save();
    return result;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      log('state write failed:', error && error.message);
      throw fail('无法保存 SSH 配置: ' + (error && error.message));
    }
  }
}

// ---------------------------------------------------------------------------
// SSH transport
// ---------------------------------------------------------------------------

/**
 * Validate an SSH destination token.
 *
 * This is a security boundary, not cosmetics. `ssh` parses anything beginning
 * with `-` as an OPTION, not a destination, so a value such as
 * `-oProxyCommand=cmd.exe /c <anything>` turns a configuration field into LOCAL
 * COMMAND EXECUTION (verified: without this check the command runs; with `--`
 * in front of the destination ssh instead reports "Could not resolve hostname").
 * Enforced on every write path — add AND update.
 */
function validateSshHost(value) {
  const host = String(value == null ? '' : value).trim();
  if (!host) throw fail('主机地址不能为空');
  if (host.startsWith('-')) throw fail('主机地址不能以 “-” 开头: ' + host);
  if (!/^[A-Za-z0-9._:@\-\[\]]+$/.test(host)) throw fail('主机地址包含非法字符: ' + host);
  return host;
}

/** A user name is prepended to the destination as `user@host`, so a leading
 *  `-` would again be parsed by ssh as an option. */
function validateSshUser(value) {
  const user = String(value == null ? '' : value).trim();
  if (!user) return '';
  if (user.startsWith('-')) throw fail('用户名不能以 “-” 开头: ' + user);
  if (!/^[A-Za-z0-9._\-]+$/.test(user)) throw fail('用户名包含非法字符: ' + user);
  return user;
}

/** `-i` consumes the next argument, but a value that is itself an option is
 *  still worth refusing, and a path must not carry control characters. */
function validateIdentityFile(value) {
  const file = String(value == null ? '' : value).trim();
  if (!file) return '';
  if (file.startsWith('-')) throw fail('私钥路径不能以 “-” 开头');
  if (/[\n\r\0]/.test(file)) throw fail('私钥路径包含非法字符');
  return file;
}

/** The remote launcher command. It runs on the far side by design, but it must
 *  never be able to alter how ssh parses our own argv. */
function validateRemoteDsh(value) {
  const command = String(value == null ? '' : value).trim();
  if (!command) return 'dsh --profile acp';
  if (/\0/.test(command)) throw fail('远程 dsh 命令包含非法字符');
  if (command.length > 512) throw fail('远程 dsh 命令过长');
  return command;
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 22;
  return port;
}

function sshBaseArgs(host) {
  // Single choke point: every ssh spawn (connect, runSsh, testHost) builds its
  // argv here, so validate here as well as at the write paths. A caller-supplied
  // host object that never went through addHost/updateHost cannot slip past.
  const safeHost = validateSshHost(host && host.host);
  const safeUser = validateSshUser(host && host.user);
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  args.push('-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3');
  if (host.port && Number(host.port) !== 22) args.push('-p', String(validatePort(host.port)));
  if (host.identityFile && host.identityFile.trim()) args.push('-i', validateIdentityFile(host.identityFile));
  // `--` ends option parsing: even a value that slipped past validation is then
  // treated as a (bogus) hostname instead of an ssh option.
  args.push('--');
  args.push(safeUser ? safeUser + '@' + safeHost : safeHost);
  return args;
}

/**
 * Run one short-lived remote command over ssh and collect its output.
 * Used for probing, directory resolution, and remote directory listing.
 */
function runSsh(host, remoteCommand, { timeoutMs = 30000, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh', [...sshBaseArgs(host), remoteCommand], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error && error.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout after ' + timeoutMs + 'ms]' });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // A write to a pipe whose peer already exited raises EPIPE on the stream.
    // With no 'error' listener that becomes an uncaughtException and takes the
    // whole Host process down, so every stream we write to needs one.
    child.stdin.on('error', (error) => {
      log('ssh stdin error: ' + (error && error.message));
    });
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 400_000) stderr = stderr.slice(-200_000); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + (error && error.message) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Render a user-supplied remote directory for a POSIX shell.
 *
 * A quoted `'~'` is literal, so `cd '~'` fails with "No such file or directory"
 * — and `~` is exactly what the directory picker and addWorkspace default to.
 * Leaving it unquoted instead lets shell metacharacters through, so expand only
 * a LEADING `~` against `$HOME` and quote every other segment.
 */
function remotePathArg(dir) {
  const value = String(dir == null ? '' : dir);
  const quote = (part) => "'" + part.replace(/'/g, `'\\''`) + "'";
  if (value === '~') return '"$HOME"';
  if (value.startsWith('~/')) return '"$HOME"/' + quote(value.slice(2));
  // Quoting does NOT stop a shell builtin from reading a leading `-` as an
  // option: `cd '-P'` resolves to $HOME (verified), and `cd '-'` goes to the
  // previous directory. Prefixing `./` keeps the literal path literal.
  if (value.startsWith('-')) return quote('./' + value);
  return quote(value);
}

/**
 * Stable identity of the remote *MACHINE*.
 *
 * A host entry is only a route to a machine. The same box reached over a LAN
 * address and over Tailscale is one machine with two endpoints, and its
 * workspaces and sessions must not be partitioned per route. `/etc/machine-id`
 * is the primary key; hostname plus $HOME is the fallback for systems without
 * it (macOS, containers).
 */
async function remoteFingerprint(host) {
  const script = [
    'printf "mid=%s\\n" "$(cat /etc/machine-id 2>/dev/null || echo unknown)"',
    'printf "host=%s\\n" "$(hostname 2>/dev/null || echo unknown)"',
    'printf "home=%s\\n" "$HOME"',
  ].join('; ');
  const result = await runSsh(host, script, { timeoutMs: 20000 });
  if (result.code !== 0) return null;
  const out = result.stdout || '';
  const mid = ((out.match(/^mid=(.*)$/m) || [])[1] || '').trim();
  const hostname = ((out.match(/^host=(.*)$/m) || [])[1] || '').trim();
  const home = ((out.match(/^home=(.*)$/m) || [])[1] || '').trim();
  const usable = mid && mid !== 'unknown';
  if (!usable && (!hostname || hostname === 'unknown')) return null;
  // Include the login's HOME in the key. Two routes to the same box but as
  // different accounts (devuser@box vs root@box) are genuinely different
  // namespaces — different HOME, different files — so they must not merge.
  const account = home || 'unknown-home';
  return {
    machineKey: (usable ? 'mid:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa + mid : 'host:' + hostname) + ':' + account,
    machineName: hostname || 'unknown',
    home,
  };
}

// ---------------------------------------------------------------------------
// Agent Client Protocol client (newline-delimited JSON-RPC 2.0 over stdio)
// ---------------------------------------------------------------------------

export const ACP_PROTOCOL_VERSION = 1;

class AcpConnection {
  /**
   * @param {object} options
   * @param {object} options.host persisted host definition
   * @param {(event: object) => void} options.onUpdate `session/update` notification
   * @param {(request: object) => void} options.onPermission `session/request_permission`
   * @param {(info: {status: string, error?: string}) => void} options.onStatus
   */
  constructor(options) {
    this.host = options.host;
    this.onUpdate = options.onUpdate ?? (() => {});
    this.onPermission = options.onPermission ?? (() => {});
    this.onStatus = options.onStatus ?? (() => {});
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.closed = false;
    this.agentInfo = null;
    this.capabilities = null;
    this.disconnectedReason = null;
  }

  get hostLabel() {
    const h = this.host;
    return h.name || (h.user ? h.user + '@' + h.host : h.host);
  }

  spawnArgs() {
    const remoteDsh = (this.host.remoteDsh && this.host.remoteDsh.trim()) || 'dsh --profile acp';
    return [...sshBaseArgs(this.host), remoteDsh];
  }

  async connect() {
    if (this.child) throw fail('该主机已连接');
    this.closed = false;
    this.disconnectedReason = null;
    this.onStatus({ status: 'connecting' });

    let child;
    try {
      child = spawn('ssh', this.spawnArgs(), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      throw fail('无法启动 ssh: ' + (error && error.message));
    }
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // See runSsh: an unhandled EPIPE on stdin would be an uncaughtException.
    child.stdin.on('error', (error) => {
      log('[' + this.hostLabel + '] stdin error: ' + (error && error.message));
    });
    child.stdout.on('data', (chunk) => this.#feed(chunk));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log('[' + this.hostLabel + '] stderr: ' + text.slice(0, 500));
      this.lastStderr = text.slice(-2000);
    });
    child.on('error', (error) => {
      const message = error && error.code === 'ENOENT'
        ? '找不到 ssh 可执行文件，请安装 OpenSSH 客户端'
        : 'ssh 启动失败: ' + (error && error.message);
      this.#teardown(message);
    });
    child.on('close', (code) => {
      this.#teardown(code === 0 ? '远程 dsh 已退出' : 'ssh 连接断开 (exit ' + code + ')' + (this.lastStderr ? ': ' + this.lastStderr : ''));
    });

    try {
      const result = await this.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }, 90000);
      this.agentInfo = result && result.agentInfo ? result.agentInfo : null;
      this.capabilities = result && result.agentCapabilities ? result.agentCapabilities : null;
      this.ready = true;
      this.onStatus({ status: 'connected' });
      return { agentInfo: this.agentInfo, protocolVersion: result && result.protocolVersion };
    } catch (error) {
      const message = (error && error.message) || String(error);
      this.#teardown('initialize 失败: ' + message);
      throw fail('无法与远程 DSH 握手: ' + message + (this.lastStderr ? '\n' + this.lastStderr : ''));
    }
  }

  #feed(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        log('[' + this.hostLabel + '] 忽略无法解析的帧: ' + line.slice(0, 200));
        continue;
      }
      this.#dispatch(frame);
    }
    if (this.buffer.length > 8_000_000) {
      log('[' + this.hostLabel + '] 帧缓冲溢出，丢弃');
      this.buffer = '';
    }
  }

  #dispatch(frame) {
    const hasId = frame.id !== undefined && frame.id !== null;
    const hasMethod = typeof frame.method === 'string';

    if (hasId && hasMethod) {
      // Server -> client request.
      this.#handleIncomingRequest(frame);
      return;
    }
    if (hasId && !hasMethod) {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.error) {
        const error = fail(frame.error.message || 'ACP 请求失败');
        error.rpcCode = frame.error.code;
        error.rpcData = frame.error.data;
        entry.reject(error);
      } else {
        entry.resolve(frame.result === undefined ? {} : frame.result);
      }
      return;
    }
    if (!hasId && hasMethod) {
      this.#handleNotification(frame);
    }
  }

  #handleIncomingRequest(frame) {
    const method = frame.method;
    const reply = (result) => this.#send({ jsonrpc: '2.0', id: frame.id, result });
    const replyError = (code, message) => this.#send({ jsonrpc: '2.0', id: frame.id, error: { code, message } });

    if (method === 'session/request_permission') {
      // The remote agent is asking the operator to authorize a tool call.
      try {
        this.onPermission({ ...frame.params, requestId: frame.id, hostId: this.host.id, reply });
      } catch (error) {
        log('permission handler failed:', error && error.message);
        reply({ outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    if (method === 'session/update') {
      this.#handleNotification(frame);
      reply({});
      return;
    }
    // Unknown client method: answer so the remote side never waits forever.
    replyError(-32601, 'method not supported by this client: ' + method);
  }

  #handleNotification(frame) {
    if (frame.method === 'session/update') {
      try {
        this.onUpdate(frame.params || {});
      } catch (error) {
        log('update handler failed:', error && error.message);
      }
      return;
    }
    log('[' + this.hostLabel + '] 未处理的通知: ' + frame.method);
  }

  #send(frame) {
    const child = this.child;
    // `writableEnded` matters too: `end()` was called somewhere, and writing
    // after that throws ERR_STREAM_WRITE_AFTER_END.
    if (!child || child.stdin.destroyed || child.stdin.writableEnded) return false;
    try {
      child.stdin.write(JSON.stringify(frame) + '\n');
      return true;
    } catch (error) {
      log('write failed:', error && error.message);
      return false;
    }
  }

  request(method, params, timeoutMs = 120000) {
    if (!this.child) return Promise.reject(fail('SSH 连接未建立'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail('远程 ' + method + ' 超时 (' + timeoutMs + 'ms)'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.#send({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(fail('SSH 通道不可写'));
      }
    });
  }

  notify(method, params) {
    return this.#send({ jsonrpc: '2.0', method, params });
  }

  #teardown(reason) {
    if (this.closed && !this.child) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.disconnectedReason = reason || '连接已关闭';
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(fail(this.disconnectedReason));
    }
    this.pending.clear();
    if (child) {
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    }
    this.onStatus({ status: 'disconnected', error: this.disconnectedReason });
  }

  dispose(reason) {
    this.#teardown(reason || '已断开连接');
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const MAX_TRANSCRIPT = 4000;

class SshRemotes {
  constructor() {
    this.store = new Store(path.join(dshHome(), 'ssh-remotes', 'config.json'));
    /** @type {Map<string, AcpConnection>} */
    this.connections = new Map();
    /**
     * sessionId -> {
     *   sessionId, hostId, cwd, workspaceId, title, status,
     *   items: [], seq, pendingPermission: null, lastError, createdAt, updatedAt,
     *   active: boolean, adopted: boolean
     * }
     */
    this.sessions = new Map();
    // Keyed by MACHINE identity, not by connection record: the same machine
    // reached over LAN and over Tailscale must share one cache.
    this.remoteSessionsCache = new Map(); // machineKey -> {at, sessions: []}
    this.disposed = false;
  }

  // ---- hosts -------------------------------------------------------------

  listHosts() {
    return this.store.state.hosts.map((host) => {
      const connection = this.connections.get(host.id);
      const connected = Boolean(connection && connection.ready);
      return {
        ...host,
        connected,
        status: connected ? 'connected' : connection ? 'error' : 'idle',
        error: connection && !connected ? connection.disconnectedReason : undefined,
        agentInfo: connected ? connection.agentInfo : undefined,
      };
    });
  }

  #requireHost(hostId) {
    const host = this.store.state.hosts.find((candidate) => candidate.id === hostId);
    if (!host) throw fail('找不到主机: ' + hostId);
    return host;
  }

  // ---- machine identity --------------------------------------------------

  /** The machine a host entry routes to; falls back to its own id before the
   *  remote fingerprint is known. */
  #machineKeyOfHost(host) {
    return (host && host.machineKey) || (host && host.id);
  }

  /** The machine a stored workspace belongs to. */
  #machineKeyOfWorkspace(workspace) {
    if (!workspace) return '';
    if (workspace.machineKey) return workspace.machineKey;
    const host = this.store.state.hosts.find((candidate) => candidate.id === workspace.hostId);
    return this.#machineKeyOfHost(host) || workspace.hostId;
  }

  #hostsOfMachine(machineKey) {
    return this.store.state.hosts.filter((host) => this.#machineKeyOfHost(host) === machineKey);
  }

  /**
   * A live endpoint for one machine: any already-connected route first, then
   * the preferred one, then the rest — connecting on demand.
   */
  async #endpointFor(machineKey, preferredHostId) {
    const hosts = this.#hostsOfMachine(machineKey);
    if (hosts.length === 0) throw fail('找不到该机器对应的主机: ' + machineKey);
    const live = hosts.find((host) => {
      const connection = this.connections.get(host.id);
      return connection && connection.ready;
    });
    if (live) return live;
    // Prefer the requested route, then try the rest — but keep a stable order
    // instead of a comparator (the previous one only ever "worked" because a
    // comparator may return -1 for one element regardless of the other).
    const ordered = preferredHostId
      ? [...hosts.filter((host) => host.id === preferredHostId), ...hosts.filter((host) => host.id !== preferredHostId)]
      : hosts;
    let lastError;
    for (const host of ordered) {
      try {
        await this.connect(host.id);
        return host;
      } catch (error) {
        lastError = error;
      }
    }
    throw fail('该机器的所有入口都无法连接：' + ((lastError && lastError.message) || '未知错误'));
  }

  /**
   * Record what machine a host routes to, adopt every workspace that was
   * created through that host, and collapse duplicates that the old
   * per-connection model produced (same directory reached via two routes).
   */
  #adoptMachine(hostId, fingerprint) {
    if (!fingerprint || !fingerprint.machineKey) return;
    const next = fingerprint.machineKey;
    // 'mid:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa or 'host:<hostname>' — the part that identifies the
    // physical box independently of the account and of the key format version.
    const prefix = next.split(':').slice(0, 2).join(':');
    this.store.update((state) => {
      const host = state.hosts.find((candidate) => candidate.id === hostId);
      if (!host) return;
      host.machineKey = next;
      host.machineName = fingerprint.machineName;
      host.machineHome = fingerprint.home;
      for (const workspace of state.workspaces) {
        if (workspace.hostId !== hostId) continue;
        const current = workspace.machineKey;
        // Upgrade an unresolved key (missing, or the route id fallback) and an
        // older key format for the SAME box — otherwise a workspace created
        // while the fingerprint probe failed stays stranded forever.
        if (!current || current === hostId || current === prefix || current.startsWith(prefix + ':')) {
          workspace.machineKey = next;
        }
      }
      // Collapse same-directory duplicates across routes.
      const seen = new Map();
      const kept = [];
      for (const workspace of state.workspaces) {
        const key = (workspace.machineKey || workspace.hostId) + '\u0000' + workspace.cwd;
        const first = seen.get(key);
        if (!first) {
          seen.set(key, workspace);
          kept.push(workspace);
          continue;
        }
        // Keep the earlier record, but adopt a custom name if only the
        // duplicate has one that differs from the directory basename.
        if ((!first.name || first.name === path.posix.basename(first.cwd)) && workspace.name) {
          first.name = workspace.name;
        }
      }
      state.workspaces = kept;
    });
  }

  async addHost(input) {
    const host = validateSshHost(input && input.host);
    const name = String((input && input.name) || host).trim();
    const record = {
      id: shortId('host'),
      name,
      host,
      user: validateSshUser(input && input.user),
      port: validatePort(input && input.port),
      identityFile: validateIdentityFile(input && input.identityFile),
      remoteDsh: validateRemoteDsh(input && input.remoteDsh),
      defaultDir: String((input && input.defaultDir) || '').trim(),
      createdAt: nowMs(),
    };
    this.store.update((state) => {
      state.hosts.push(record);
    });
    return record;
  }

  async updateHost(input) {
    const id = String(input && input.id);
    let routeChanged = false;
    // Validate FIRST, outside the store mutation, so a rejected value never
    // reaches the file. The previous version skipped validation entirely here,
    // which is what made the option-injection reachable after a safe add.
    const patch = {};
    if (input && input.host !== undefined) patch.host = validateSshHost(input.host);
    if (input && input.user !== undefined) patch.user = validateSshUser(input.user);
    if (input && input.identityFile !== undefined) patch.identityFile = validateIdentityFile(input.identityFile);
    if (input && input.remoteDsh !== undefined) patch.remoteDsh = validateRemoteDsh(input.remoteDsh);
    if (input && input.port !== undefined) patch.port = validatePort(input.port);

    const host = this.store.update((state) => {
      const found = state.hosts.find((candidate) => candidate.id === id);
      if (!found) throw fail('找不到主机: ' + id);
      const previousRoute = [found.host, found.user, found.port].join('|');
      for (const field of ['name', 'defaultDir']) {
        if (input && input[field] !== undefined) found[field] = String(input[field]).trim();
      }
      Object.assign(found, patch);
      // A changed route may point at a different machine; drop the cached
      // identity so the next connect re-fingerprints instead of inheriting it.
      // The workspaces and sessions go back to the unresolved route key so they
      // stay visible (grouped under this route) instead of going dark, and the
      // next connect re-adopts them.
      if ([found.host, found.user, found.port].join('|') !== previousRoute) {
        delete found.machineKey;
        delete found.machineName;
        delete found.machineHome;
        routeChanged = true;
        for (const workspace of state.workspaces) {
          if (workspace.hostId === found.id) workspace.machineKey = found.id;
        }
      }
      return found;
    });
    if (this.connections.has(host.id)) await this.disconnect(host.id);
    if (routeChanged) {
      for (const session of this.sessions.values()) {
        if (session.hostId === host.id) session.machineKey = host.id;
      }
    }
    return host;
  }

  async removeHost(input) {
    const id = String(input && input.id);
    this.store.reload();
    const host = this.#requireHost(id);
    const machineKey = this.#machineKeyOfHost(host);
    await this.disconnect(id).catch(() => undefined);
    // Removing one route must not erase a machine that another route still
    // reaches: its workspaces and sessions stay, only this endpoint goes. If
    // another route's fingerprint has not been learned yet we cannot prove it is
    // a DIFFERENT machine, so keep everything rather than destroy user data.
    const remainingRoutes = this.#hostsOfMachine(machineKey).filter((candidate) => candidate.id !== id);
    this.store.update((state) => {
      state.hosts = state.hosts.filter((candidate) => candidate.id !== id);
      if (remainingRoutes.length === 0) {
        state.workspaces = state.workspaces.filter(
          (workspace) => (workspace.machineKey || workspace.hostId) !== machineKey,
        );
      }
      // Otherwise leave every workspace untouched, including its hostId — an
      // undefined hostId used to orphan the record into "(已删除的主机)".
    });
    if (remainingRoutes.length === 0) {
      for (const [sessionId, session] of [...this.sessions]) {
        if ((session.machineKey || session.hostId) === machineKey) this.sessions.delete(sessionId);
      }
      this.remoteSessionsCache.delete(machineKey);
    }
    return { id, removedMachine: remainingRoutes.length === 0 };
  }

  /**
   * Probe a host without keeping a connection: verify ssh reachability and that
   * the remote `dsh` launcher exists.
   */
  async testHost(input) {
    // Require a persisted host: accepting a raw caller-supplied object would let
    // an unvalidated value reach sshBaseArgs, which is exactly the injection
    // shape (the guard also makes it fail closed, but reject it outright here).
    if (!input || !input.id) {
      throw fail('host.test 需要一个已保存的主机 id（不接受未保存的主机对象）');
    }
    const host = this.#requireHost(String(input.id));
    const command = [
      'uname -s 2>/dev/null || echo unknown',
      'echo "---DshVersion---"',
      '(dsh --version 2>&1 || echo MISSING)',
      'echo "---DshPath---"',
      '(command -v dsh || echo MISSING)',
      'echo "---MachineId---"',
      '(cat /etc/machine-id 2>/dev/null || echo unknown)',
      'echo "---Hostname---"',
      '(hostname 2>/dev/null || echo unknown)',
      'echo "---Home---"',
      'echo "$HOME"',
    ].join('; ');
    const started = nowMs();
    const result = await runSsh(host, command, { timeoutMs: 30000 });
    const stdout = result.stdout || '';
    const sections = stdout.split('---');
    const platform = (sections[0] || '').trim().split('\n')[0] || 'unknown';
    const field = (name) => {
      const m = stdout.match(new RegExp('---' + name + '---\\s*\\n([^\\n]*)'));
      return m ? m[1].trim() : '';
    };
    const dshVersion = field('DshVersion');
    const dshPath = field('DshPath');
    const machineId = field('MachineId');
    const hostname = field('Hostname');
    const home = field('Home');
    let fingerprint = null;
    if (result.code === 0 && ((machineId && machineId !== 'unknown') || (hostname && hostname !== 'unknown'))) {
      fingerprint = {
        machineKey: machineId && machineId !== 'unknown' ? 'mid:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa + machineId : 'host:' + hostname + ':' + home,
        machineName: hostname || 'unknown',
        home,
      };
      if (input && input.id) this.#adoptMachine(String(input.id), fingerprint);
    }
    const ok = result.code === 0 && dshVersion && dshVersion !== 'MISSING';
    return {
      ok,
      platform,
      dshVersion: dshVersion === 'MISSING' ? '' : dshVersion,
      dshPath: dshPath === 'MISSING' ? '' : dshPath,
      exitCode: result.code,
      elapsedMs: nowMs() - started,
      machineKey: fingerprint ? fingerprint.machineKey : undefined,
      machineName: fingerprint ? fingerprint.machineName : undefined,
      message: ok
        ? '连接成功，远程 dsh ' + dshVersion
        : result.code !== 0
          ? 'SSH 连接失败: ' + ((result.stderr || '').trim().slice(0, 600) || 'exit ' + result.code)
          : 'SSH 可用，但远程未找到 dsh 命令',
      stderr: (result.stderr || '').trim().slice(0, 2000),
    };
  }

  // ---- connection --------------------------------------------------------

  connectionFor(hostId) {
    const existing = this.connections.get(hostId);
    if (existing && existing.ready) return existing;
    return undefined;
  }

  async connect(hostId) {
    const host = this.#requireHost(hostId);
    const existing = this.connections.get(hostId);
    if (existing && existing.ready) {
      return { hostId, agentInfo: existing.agentInfo, alreadyConnected: true };
    }
    // Two concurrent callers (a UI click plus a queued session.create) used to
    // race: the loser disposed the winner's connection and then deleted the
    // winner's map entry, leaving a live ssh child nothing could reach. Join an
    // in-flight attempt instead.
    if (existing && existing.pendingConnect) return existing.pendingConnect;
    if (existing) existing.dispose('重连');
    const connection = new AcpConnection({
      host,
      onUpdate: (params) => this.#onSessionUpdate(host.id, params),
      onPermission: (request) => this.#onPermissionRequest(host.id, request),
      onStatus: (info) => {
        if (info.status === 'disconnected') {
          // Surface the loss on every live session of that host.
          for (const session of this.sessions.values()) {
            if (session.hostId !== host.id) continue;
            session.status = 'disconnected';
            session.updatedAt = nowMs();
            this.#push(session, { kind: 'notice', level: 'error', text: 'SSH 连接断开: ' + (info.error || '') });
            session.pendingPermission = null;
          }
        }
      },
    });
    this.connections.set(host.id, connection);
    const attempt = (async () => {
      try {
        const info = await connection.connect();
        // Learn which machine this route reaches, so a second route to the same
        // box joins the same workspace/session namespace instead of starting a
        // second one. Failure here is non-fatal: the connection still works.
        try {
          const fingerprint = await remoteFingerprint(host);
          this.#adoptMachine(host.id, fingerprint);
        } catch (error) {
          log('fingerprint failed for ' + host.name + ': ' + (error && error.message));
        }
        return { hostId, agentInfo: info.agentInfo, protocolVersion: info.protocolVersion };
      } catch (error) {
        // Only clean up when the map still holds THIS connection.
        if (this.connections.get(host.id) === connection) this.connections.delete(host.id);
        throw error;
      } finally {
        connection.pendingConnect = null;
      }
    })();
    connection.pendingConnect = attempt;
    return attempt;
  }

  async disconnect(hostId) {
    const connection = this.connections.get(hostId);
    if (!connection) return { hostId, disconnected: false };
    this.connections.delete(hostId);
    for (const session of this.sessions.values()) {
      if (session.hostId === hostId) {
        session.status = 'closed';
        session.pendingPermission = null;
      }
    }
    connection.dispose('用户断开连接');
    return { hostId, disconnected: true };
  }

  // ---- workspaces --------------------------------------------------------

  listWorkspaces() {
    return this.store.state.workspaces.map((workspace) => {
      const host = this.store.state.hosts.find((candidate) => candidate.id === workspace.hostId);
      const machineKey = this.#machineKeyOfWorkspace(workspace);
      const machineHost = this.#hostsOfMachine(machineKey)[0];
      return {
        ...workspace,
        machineKey,
        machineName: machineHost ? machineHost.machineName || machineHost.name : '(已删除)',
        hostName: host ? host.name : '(已删除的主机)',
        hostAvailable: Boolean(host),
      };
    });
  }

  /**
   * Resolve a remote directory to an absolute physical path and remember it as
   * a remote workspace. `~` and relative paths are resolved on the remote.
   */
  async addWorkspace(input) {
    const host = this.#requireHost(input && input.hostId);
    const raw = String((input && input.dir) || '').trim() || '~';
    if (/[\n\r\0]/.test(raw)) throw fail('目录包含非法字符');
    const result = await runSsh(host, 'cd ' + remotePathArg(raw) + ' && pwd -P', { timeoutMs: 25000 });
    if (result.code !== 0) {
      throw fail('远程目录不可用: ' + raw + ' — ' + ((result.stderr || '').trim().slice(0, 400) || 'exit ' + result.code));
    }
    const cwd = (result.stdout || '').trim().split('\n').pop().trim();
    if (!cwd.startsWith('/')) throw fail('远程目录不是绝对路径: ' + cwd);
    const requested = String((input && input.name) || '').trim();
    if (requested.length > WORKSPACE_NAME_MAX) {
      throw fail('工作区名称过长（最多 ' + WORKSPACE_NAME_MAX + ' 字符）');
    }
    // A route is not an identity: learn the machine first (if this route has
    // never reported it), then create inside the MACHINE's namespace so the
    // same directory reached over another route resolves to this same entry.
    if (!host.machineKey) {
      try {
        this.#adoptMachine(host.id, await remoteFingerprint(host));
      } catch (error) {
        log('fingerprint during addWorkspace failed: ' + (error && error.message));
      }
    }
    const machineKey = this.#machineKeyOfHost(this.#requireHost(host.id));
    return this.store.update((state) => {
      const existing = state.workspaces.find(
        (workspace) => (workspace.machineKey || workspace.hostId) === machineKey && workspace.cwd === cwd,
      );
      if (existing) return existing;
      const record = {
        id: shortId('ws'),
        hostId: host.id,
        machineKey,
        cwd,
        // Operator-supplied name wins; otherwise fall back to the last path
        // segment so a fresh entry is never nameless.
        name: requested || path.posix.basename(cwd) || cwd,
        createdAt: nowMs(),
      };
      state.workspaces.push(record);
      return record;
    });
  }

  /** Rename one remote workspace. Only the local label changes; the remote
   *  directory and any sessions running in it are untouched. */
  async renameWorkspace(input) {
    const id = String(input && input.id);
    const name = String((input && input.name) || '').trim();
    if (!name) throw fail('工作区名称不能为空');
    if (/[\n\r\0]/.test(name)) throw fail('工作区名称包含非法字符');
    if (name.length > WORKSPACE_NAME_MAX) {
      throw fail('工作区名称过长（最多 ' + WORKSPACE_NAME_MAX + ' 字符）');
    }
    return this.store.update((state) => {
      const found = state.workspaces.find((workspace) => workspace.id === id);
      if (!found) throw fail('找不到远程工作区: ' + id);
      found.name = name;
      found.renamedAt = nowMs();
      return found;
    });
  }

  async removeWorkspace(input) {
    const id = String(input && input.id);
    this.store.update((state) => {
      state.workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
    });
    return { id };
  }

  /** List directories on the remote host (for the picker in the UI). */
  async browseRemote(input) {
    const host = this.#requireHost(input && input.hostId);
    const dir = String((input && input.dir) || '~').trim();
    const script = [
      'cd ' + remotePathArg(dir) + ' 2>/dev/null || { echo "__ERR__"; exit 3; }',
      'pwd -P',
      'echo "__LIST__"',
      'ls -1Ap 2>/dev/null | head -400',
    ].join('; ');
    const result = await runSsh(host, script, { timeoutMs: 25000 });
    const stdout = result.stdout || '';
    const marker = stdout.indexOf('__LIST__');
    if (result.code !== 0 || marker < 0) {
      throw fail('无法列出远程目录 ' + dir + ': ' + ((result.stderr || '').trim().slice(0, 400) || 'exit ' + result.code));
    }
    const resolved = stdout.slice(0, marker).trim();
    const entries = stdout
      .slice(marker + '__LIST__'.length)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ name: line.replace(/\/$/, ''), dir: line.endsWith('/') }))
      .filter((entry) => entry.name !== '.' && entry.name !== '..');
    return { cwd: resolved, entries };
  }

  // ---- sessions ----------------------------------------------------------

  /** Find a workspace by its machine's namespace + directory (a route id also
   *  matches, so pre-migration records still resolve). */
  #workspaceFor(machineKeyOrHostId, cwd) {
    return this.store.state.workspaces.find(
      (workspace) =>
        workspace.cwd === cwd &&
        ((workspace.machineKey || workspace.hostId) === machineKeyOrHostId ||
          workspace.hostId === machineKeyOrHostId),
    );
  }

  async listRemoteSessions(input) {
    const hostId = String((input && input.hostId) || '');
    // The list belongs to the MACHINE; `hostId` is only a preferred route.
    let machineKey = String((input && input.machineKey) || '');
    if (!machineKey) {
      machineKey = this.#machineKeyOfHost(this.#requireHost(hostId));
    }
    const force = Boolean(input && input.refresh);
    const cached = this.remoteSessionsCache.get(machineKey);
    if (!force && cached && nowMs() - cached.at < 20000) return cached.sessions;

    const endpoint = await this.#endpointFor(machineKey, hostId || undefined);
    const connection = this.connectionFor(endpoint.id);
    const collected = [];
    let cursor;
    for (let page = 0; page < 5; page += 1) {
      const params = {};
      if (cursor) params.cursor = cursor;
      const result = await connection.request('session/list', params, 45000);
      const sessions = Array.isArray(result && result.sessions) ? result.sessions : [];
      collected.push(...sessions);
      cursor = result && result.nextCursor;
      if (!cursor) break;
    }
    // Active means "live on SOME route to this machine", not "on this route".
    const activeIds = new Set(
      [...this.sessions.values()]
        .filter((session) => (session.machineKey || session.hostId) === machineKey)
        .map((s) => s.sessionId),
    );
    const mapped = collected
      .filter((entry) => entry && entry.sessionId && !activeIds.has(entry.sessionId))
      .map((entry) => ({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        machineKey,
        hostId: endpoint.id,
        hostName: endpoint.name,
        workspaceId: this.#workspaceFor(machineKey, entry.cwd)?.id,
        adopted: false,
        active: false,
      }));
    this.remoteSessionsCache.set(machineKey, { at: nowMs(), sessions: mapped });
    return mapped;
  }

  async createSession(input) {
    const workspaceId = String(input && input.workspaceId);
    const workspace = this.store.state.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw fail('找不到远程工作区: ' + workspaceId);
    // Create over whichever route to that machine is usable right now.
    const machineKey = this.#machineKeyOfWorkspace(workspace);
    const host = await this.#endpointFor(machineKey, workspace.hostId);
    const connection = this.connectionFor(host.id);
    const result = await connection.request('session/new', {
      cwd: workspace.cwd,
      mcpServers: [],
    }, 60000);
    const sessionId = result && result.sessionId;
    if (!sessionId) throw fail('远程未返回会话 id');
    const session = this.#ensureSession({
      sessionId,
      hostId: host.id,
      machineKey,
      cwd: workspace.cwd,
      workspaceId: workspace.id,
      title: String((input && input.title) || '').trim() || '新远程会话',
      active: true,
    });
    session.configOptions = result.configOptions;
    this.remoteSessionsCache.delete(machineKey);
    return this.#sessionSummary(session);
  }

  /** Adopt an existing persisted remote session so it can be prompted again. */
  async resumeSession(input) {
    const hostId = String(input && input.hostId);
    const host = this.#requireHost(hostId);
    const sessionId = String(input && input.sessionId);
    if (!sessionId) throw fail('缺少 sessionId');
    const cwd = String((input && input.cwd) || '');
    if (!cwd) throw fail('缺少 cwd');
    const machineKey = this.#machineKeyOfHost(host);
    const endpoint = await this.#endpointFor(machineKey, hostId);
    const connection = this.connectionFor(endpoint.id);
    await connection.request('session/resume', { sessionId, cwd, mcpServers: [] }, 60000);
    const session = this.#ensureSession({
      sessionId,
      hostId: endpoint.id,
      machineKey,
      cwd,
      workspaceId: this.#workspaceFor(machineKey, cwd)?.id,
      title: String((input && input.title) || '').trim() || '远程会话 ' + sessionId.slice(-8),
      active: true,
    });
    session.status = 'idle';
    this.remoteSessionsCache.delete(machineKey);
    return this.#sessionSummary(session);
  }

  async closeSession(input) {
    const sessionId = String(input && input.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, closed: false };
    const connection = this.connections.get(session.hostId);
    if (connection && connection.ready) {
      try {
        await connection.request('session/close', { sessionId }, 20000);
      } catch (error) {
        log('session/close failed: ' + (error && error.message));
      }
    }
    session.active = false;
    session.status = 'closed';
    session.pendingPermission = null;
    this.sessions.delete(sessionId);
    this.remoteSessionsCache.delete(session.machineKey || session.hostId);
    return { sessionId, closed: true };
  }

  async promptSession(input) {
    const sessionId = String(input && input.sessionId);
    const text = String((input && input.text) || '');
    const blocks = Array.isArray(input && input.blocks) ? input.blocks : null;
    const session = this.sessions.get(sessionId);
    if (!session) throw fail('找不到远程会话: ' + sessionId);
    if (!text && !blocks) throw fail('消息内容为空');
    const connection = this.connectionFor(session.hostId);
    if (!connection) throw fail('该会话的主机未连接，请先连接');
    if (session.busy) throw fail('该会话正在运行，请先等待或取消');

    const prompt = blocks ?? [{ type: 'text', text }];
    if (session.title === '新远程会话' && text) {
      session.title = text.replace(/\s+/g, ' ').trim().slice(0, 40) || session.title;
    }
    this.#push(session, { kind: 'user', text: text || prompt.map((b) => b.text || '').join('') });
    session.busy = true;
    session.status = 'running';
    session.updatedAt = nowMs();

    connection
      .request('session/prompt', { sessionId, prompt }, 60 * 60 * 1000)
      .then((result) => {
        session.busy = false;
        session.status = session.status === 'disconnected' ? session.status : 'idle';
        session.updatedAt = nowMs();
        this.#push(session, { kind: 'turn', stopReason: (result && result.stopReason) || 'end_turn' });
      })
      .catch((error) => {
        session.busy = false;
        session.status = 'error';
        session.lastError = (error && error.message) || String(error);
        session.updatedAt = nowMs();
        this.#push(session, { kind: 'notice', level: 'error', text: '运行失败: ' + session.lastError });
      });

    return { sessionId, accepted: true };
  }

  cancelSession(input) {
    const sessionId = String(input && input.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw fail('找不到远程会话: ' + sessionId);
    const connection = this.connectionFor(session.hostId);
    if (!connection) throw fail('该会话的主机未连接');
    // session/cancel is a notification, not a request.
    connection.notify('session/cancel', { sessionId });
    this.#push(session, { kind: 'notice', level: 'warn', text: '已请求取消当前回合' });
    return { sessionId, cancelled: true };
  }

  answerPermission(input) {
    const sessionId = String(input && input.sessionId);
    const session = this.sessions.get(sessionId);
    const pending = session && session.pendingPermission;
    if (!session || !pending) throw fail('该会话没有待授权的请求');
    const optionId = String((input && input.optionId) || '');
    const option = pending.options.find((candidate) => candidate.optionId === optionId);
    if (!option && optionId !== '__cancel__') throw fail('无效的授权选项: ' + optionId);
    session.pendingPermission = null;
    this.#push(session, {
      kind: 'notice',
      level: optionId === '__cancel__' ? 'warn' : 'info',
      text: optionId === '__cancel__'
        ? '已拒绝远程授权请求'
        : '已授权: ' + (option ? option.name : optionId),
    });
    if (optionId === '__cancel__') {
      pending.__reply({ outcome: { outcome: 'cancelled' } });
    } else {
      pending.__reply({ outcome: { outcome: 'selected', optionId } });
    }
    return { sessionId, answered: true };
  }

  #push(session, item) {
    session.seq += 1;
    const record = { id: shortId('it'), seq: session.seq, at: nowMs(), ...item };
    session.items.push(record);
    if (session.items.length > MAX_TRANSCRIPT) {
      session.items.splice(0, session.items.length - MAX_TRANSCRIPT);
    }
    session.updatedAt = nowMs();
    return record;
  }

  /**
   * Re-deliver an item that changed IN PLACE.
   *
   * Streaming reuses one item and grows its text. The client polls with an
   * append-only cursor (`seq > since`), so without bumping the item's seq the
   * client would see the first chunk and then nothing — the row froze and tool
   * rows stayed on "pending".
   */
  #touch(session, item, patch) {
    Object.assign(item, patch);
    session.seq += 1;
    item.seq = session.seq;
    item.at = nowMs();
    session.updatedAt = item.at;
    return item;
  }

  #ensureSession(init) {
    const existing = this.sessions.get(init.sessionId);
    if (existing) {
      existing.active = init.active ?? existing.active;
      existing.workspaceId = init.workspaceId ?? existing.workspaceId;
      existing.cwd = init.cwd ?? existing.cwd;
      // A session resumed over a different route still belongs to the machine.
      if (init.machineKey) existing.machineKey = init.machineKey;
      if (init.hostId) existing.hostId = init.hostId;
      return existing;
    }
    const session = {
      sessionId: init.sessionId,
      hostId: init.hostId,
      machineKey: init.machineKey || this.#machineKeyOfHost(this.store.state.hosts.find((h) => h.id === init.hostId)),
      cwd: init.cwd,
      workspaceId: init.workspaceId,
      title: init.title || '远程会话',
      status: 'idle',
      busy: false,
      active: init.active !== false,
      adopted: Boolean(init.adopted),
      items: [],
      seq: 0,
      pendingPermission: null,
      lastError: undefined,
      createdAt: nowMs(),
      updatedAt: nowMs(),
    };
    this.sessions.set(init.sessionId, session);
    return session;
  }

  #onSessionUpdate(hostId, params) {
    const sessionId = params && params.sessionId;
    const update = params && params.update;
    if (!sessionId || !update) return;
    let session = this.sessions.get(sessionId);
    if (!session) {
      // A session started outside this plugin (e.g. a resumed one): adopt it.
      const owningHost = this.store.state.hosts.find((candidate) => candidate.id === hostId);
      session = this.#ensureSession({
        sessionId,
        hostId,
        machineKey: this.#machineKeyOfHost(owningHost),
        cwd: update.cwd || '',
        title: '远程会话 ' + String(sessionId).slice(-8),
        active: true,
        adopted: true,
      });
    }
    const kind = update.sessionUpdate;

    if (kind === 'agent_message_chunk') {
      const text = update.content && update.content.type === 'text' ? update.content.text : '';
      if (!text) return;
      const last = session.items[session.items.length - 1];
      if (last && last.kind === 'assistant') this.#touch(session, last, { text: last.text + text });
      else this.#push(session, { kind: 'assistant', text });
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const text = update.content && update.content.type === 'text' ? update.content.text : '';
      if (!text) return;
      const last = session.items[session.items.length - 1];
      if (last && last.kind === 'thought') this.#touch(session, last, { text: last.text + text });
      else this.#push(session, { kind: 'thought', text });
      return;
    }
    if (kind === 'user_message_chunk') {
      const text = update.content && update.content.type === 'text' ? update.content.text : '';
      if (text) this.#push(session, { kind: 'user', text });
      return;
    }
    if (kind === 'tool_call') {
      // Through #push so the transcript cap applies to tool rows too.
      this.#push(session, {
        kind: 'tool',
        toolCallId: update.toolCallId,
        title: update.title || '工具调用',
        toolKind: update.kind,
        status: update.status || 'pending',
        rawInput: update.rawInput,
        locations: update.locations,
        content: update.content,
      });
      return;
    }
    if (kind === 'tool_call_update') {
      const existing = [...session.items].reverse().find(
        (item) => item.kind === 'tool' && item.toolCallId === update.toolCallId,
      );
      if (existing) {
        const patch = {};
        if (update.status) patch.status = update.status;
        if (update.title) patch.title = update.title;
        if (update.content) patch.content = update.content;
        if (update.rawOutput) patch.rawOutput = update.rawOutput;
        // Re-deliver: without a seq bump the client's cursor never sees the
        // row leave "pending" or gain its content.
        this.#touch(session, existing, patch);
      } else {
        this.#push(session, {
          kind: 'tool',
          toolCallId: update.toolCallId,
          title: update.title || '工具调用',
          status: update.status || 'completed',
          content: update.content,
        });
      }
      return;
    }
    if (kind === 'plan') {
      this.#push(session, { kind: 'plan', entries: update.entries });
      return;
    }
    if (kind === 'config_option_update') {
      session.configOptions = update.configOptions ?? update;
      return;
    }
    if (kind === 'usage_update') {
      session.usage = update;
      return;
    }
    // Unknown update kind: keep it visible rather than silently dropping it.
    this.#push(session, { kind: 'raw', updateKind: kind, payload: update });
  }

  #onPermissionRequest(hostId, request) {
    const sessionId = request.sessionId;
    const session = this.sessions.get(sessionId);
    const options = Array.isArray(request.options) ? request.options : [];
    const entry = {
      requestId: request.requestId,
      toolCallId: request.toolCall && request.toolCall.toolCallId,
      title: (request.toolCall && request.toolCall.title) || '工具调用需要授权',
      toolKind: request.toolCall && request.toolCall.kind,
      toolName: request.toolCall && request.toolCall.name,
      rawInput: request.toolCall && request.toolCall.rawInput,
      options: options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      reply: request.reply,
    };
    if (!session) {
      // No UI attached: refuse rather than silently granting authority.
      request.reply({ outcome: { outcome: 'cancelled' } });
      return;
    }
    // DSH's ACP server sends a permission request whose `toolCall` may carry
    // only a summary title, so on its own the operator would be approving
    // blind. Fall back to the tool call this session just recorded, which does
    // carry the raw input (e.g. the exact command).
    const lastTool = [...session.items].reverse().find((item) => item.kind === 'tool');
    const rawInput = entry.rawInput !== undefined ? entry.rawInput : lastTool && lastTool.rawInput;
    const detailParts = [];
    const detailTitle = entry.title || (lastTool && lastTool.title);
    if (detailTitle) detailParts.push(detailTitle);
    if (rawInput !== undefined) {
      let rendered;
      try {
        rendered = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2);
      } catch {
        rendered = String(rawInput);
      }
      detailParts.push(rendered);
    }
    const detail = detailParts.join('\n');

    session.pendingPermission = {
      requestId: entry.requestId,
      title: entry.title,
      toolKind: entry.toolKind,
      toolName: entry.toolName || (lastTool && lastTool.title),
      rawInput,
      detail,
      options: entry.options,
    };
    session.updatedAt = nowMs();
    this.#push(session, {
      kind: 'permission',
      title: entry.title,
      detail,
      options: entry.options,
    });
    // Keep the live reply handle out of the serialized state.
    Object.defineProperty(session.pendingPermission, '__reply', {
      value: entry.reply,
      enumerable: false,
    });
  }

  #sessionSummary(session) {
    const host = this.store.state.hosts.find((candidate) => candidate.id === session.hostId);
    const workspace = this.store.state.workspaces.find((candidate) => candidate.id === session.workspaceId);
    const machineKey = session.machineKey || this.#machineKeyOfHost(host);
    const machineHost = this.#hostsOfMachine(machineKey).find((candidate) => candidate.machineName)
      || this.#hostsOfMachine(machineKey)[0];
    return {
      sessionId: session.sessionId,
      hostId: session.hostId,
      hostName: host ? host.name : '',
      machineKey,
      machineName: machineHost ? machineHost.machineName || machineHost.name : '',
      cwd: session.cwd,
      workspaceId: session.workspaceId,
      workspaceName: workspace ? workspace.name : '',
      title: session.title,
      status: session.status,
      busy: session.busy,
      active: session.active,
      adopted: session.adopted,
      seq: session.seq,
      updatedAt: session.updatedAt,
      hasPermission: Boolean(session.pendingPermission),
    };
  }

  /**
   * One node per MACHINE, with the routes that reach it nested underneath.
   * Two routes to the same box therefore share one workspace/session tree
   * instead of duplicating it.
   */
  #machineGroups(hosts) {
    const groups = [];
    const byKey = new Map();
    for (const host of hosts) {
      const key = host.machineKey || host.id;
      let group = byKey.get(key);
      if (!group) {
        group = {
          machineKey: key,
          label: host.machineName || host.name,
          endpoints: [],
          connected: false,
          endpointId: undefined,
          error: undefined,
        };
        byKey.set(key, group);
        groups.push(group);
      }
      group.endpoints.push({
        id: host.id,
        name: host.name,
        host: host.host,
        user: host.user,
        port: host.port,
        connected: host.connected,
        status: host.status,
        error: host.error,
        identityFile: host.identityFile,
        remoteDsh: host.remoteDsh,
        defaultDir: host.defaultDir,
      });
      if (host.connected) {
        group.connected = true;
        if (!group.endpointId) group.endpointId = host.id;
      }
      if (!group.error && host.error) group.error = host.error;
    }
    for (const group of groups) {
      if (!group.endpointId) group.endpointId = group.endpoints[0] && group.endpoints[0].id;
      if (!group.label || group.label === 'unknown') group.label = group.endpoints[0].name;
    }
    return groups;
  }

  // ---- RPC surface -------------------------------------------------------

  async snapshot() {
    const hosts = this.listHosts();
    const workspaces = this.listWorkspaces();
    const sessions = [...this.sessions.values()]
      .map((session) => this.#sessionSummary(session))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return {
      hosts,
      machines: this.#machineGroups(hosts),
      workspaces,
      sessions,
      acpProtocolVersion: ACP_PROTOCOL_VERSION,
    };
  }

  async poll(input) {
    const sessionId = String(input && input.sessionId);
    const since = Number(input && input.since) || 0;
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, missing: true, items: [], seq: 0 };
    const items = session.items.filter((item) => item.seq > since);
    const pending = session.pendingPermission;
    return {
      sessionId,
      items,
      seq: session.seq,
      status: session.status,
      busy: session.busy,
      title: session.title,
      active: session.active,
      pendingPermission: pending
        ? {
            title: pending.title,
            toolKind: pending.toolKind,
            toolName: pending.toolName,
            rawInput: pending.rawInput,
            detail: pending.detail,
            options: pending.options,
          }
        : null,
    };
  }

  /**
   * Block until the remote turn settles. Stops early when the remote asks for
   * authorization, so the caller can answer instead of waiting out the timeout.
   */
  async waitForSession(input) {
    const sessionId = String(input && input.sessionId);
    const since = Number(input && input.since) || 0;
    const timeoutMs = Math.max(0, Math.min(Number(input && input.timeoutMs) || 120000, 15 * 60 * 1000));
    const session = this.sessions.get(sessionId);
    if (!session) throw fail('找不到远程会话: ' + sessionId);
    const deadline = nowMs() + timeoutMs;
    while (session.busy && !session.pendingPermission && nowMs() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    const snapshot = await this.poll({ sessionId, since });
    return {
      ...snapshot,
      timedOut: Boolean(session.busy) && !session.pendingPermission && nowMs() >= deadline,
      needsPermission: Boolean(session.pendingPermission),
    };
  }

  async invoke(action, payload) {
    const input = payload || {};
    switch (action) {
      case 'state':
        return this.snapshot();
      case 'host.add':
        return { host: await this.addHost(input) };
      case 'host.update':
        return { host: await this.updateHost(input) };
      case 'host.remove':
        return await this.removeHost(input);
      case 'host.test':
        return await this.testHost(input);
      case 'host.connect':
        return await this.connect(String(input.id));
      case 'host.disconnect':
        return await this.disconnect(String(input.id));
      case 'host.browse':
        return await this.browseRemote(input);
      case 'workspace.add':
        return { workspace: await this.addWorkspace(input) };
      case 'workspace.rename':
        return { workspace: await this.renameWorkspace(input) };
      case 'workspace.remove':
        return await this.removeWorkspace(input);
      case 'session.listRemote':
        return { sessions: await this.listRemoteSessions(input) };
      case 'session.create':
        return { session: await this.createSession(input) };
      case 'session.resume':
        return { session: await this.resumeSession(input) };
      case 'session.close':
        return await this.closeSession(input);
      case 'session.prompt':
        return await this.promptSession(input);
      case 'session.cancel':
        return this.cancelSession(input);
      case 'session.poll':
        return await this.poll(input);
      case 'session.wait':
        return await this.waitForSession(input);
      case 'permission.answer':
        return this.answerPermission(input);
      case 'ping':
        return { pong: true, at: nowMs() };
      default:
        throw fail('未知操作: ' + action);
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, connection] of this.connections) {
      try { connection.dispose('插件卸载'); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}

// ---------------------------------------------------------------------------
// HTTP route: the Client half's only channel to this Host
// ---------------------------------------------------------------------------

const ROUTE_PATH = '/ssh-remote';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(fail('请求体过大'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(fail('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Guard the RPC route against drive-by requests from web pages.
 *
 * Binding to 127.0.0.1 is NOT sufficient: the user's own browser can reach
 * loopback, and a `text/plain` POST is a CORS-*simple* request, so it is
 * delivered with no preflight and the side effect happens even though the page
 * cannot read the response. Since this route can create a host and connect it,
 * that would turn any visited page into local command execution. Three
 * independent gates, each of which a foreign page cannot satisfy:
 *   1. `application/json` content type — cross-origin JSON triggers a preflight.
 *   2. a required custom header — likewise preflight-only.
 *   3. `Origin`, when present, must be this same origin.
 */
const RPC_HEADER = 'x-dsh-ssh-remote';

function sameOrigin(req, origin) {
  const host = req.headers.host;
  if (!host || !origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function guardRpcRequest(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(contentType)) return '请求必须使用 application/json';
  if (String(req.headers[RPC_HEADER] || '') !== '1') return '缺少 ' + RPC_HEADER + ' 请求头';
  const origin = req.headers.origin;
  if (origin && !sameOrigin(req, origin)) return '跨站请求被拒绝';
  return null;
}

export function apply(ctx) {
  const service = new SshRemotes();

  ctx.effect(() => {
    const webServer = ctx.get('webServer');
    if (!webServer) {
      log('未找到 webServer 服务，SSH 远程面板不可用');
      return () => {};
    }
    const dispose = webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || ROUTE_PATH, 'http://localhost');
          const tail = url.pathname.slice(ROUTE_PATH.length) || '/';
          if (req.method === 'GET' && tail === '/health') {
            sendJson(res, 200, { ok: true, at: nowMs() });
            return;
          }
          if (req.method !== 'POST' || tail !== '/rpc') {
            sendJson(res, 404, { ok: false, error: 'not found' });
            return;
          }
          const guardError = guardRpcRequest(req);
          if (guardError) {
            sendJson(res, 403, { ok: false, error: guardError });
            return;
          }
          const body = await readJsonBody(req);
          const action = String(body.action || '');
          try {
            const value = await service.invoke(action, body.payload || {});
            sendJson(res, 200, { ok: true, value });
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: (error && error.message) || String(error),
              details: error && error.details,
            });
          }
        } catch (error) {
          try {
            sendJson(res, 400, { ok: false, error: (error && error.message) || String(error) });
          } catch {
            /* ignore */
          }
        }
      },
    });
    log('已注册 ' + ROUTE_PATH + ' 路由');
    return () => {
      try { dispose(); } catch { /* ignore */ }
    };
  }, 'ssh-remotes.http');

  // Tear every ssh child down with the plugin.
  ctx.effect(() => () => {
    service.dispose().catch(() => undefined);
  }, 'ssh-remotes.dispose');

  // -------------------------------------------------------------------------
  // Agent tool: the same operations the UI drives, for the model.
  // -------------------------------------------------------------------------
  ctx.effect(() => {
    const tools = ctx.get('tools');
    if (!tools) {
      log('未找到 tools 服务，跳过 ssh_remote 工具注册');
      return () => {};
    }
    const dispose = tools.register({
      name: 'ssh_remote',
      description:
        'Manage SSH remote hosts and drive a remote headless DeepSeek Harness (dsh --profile acp) over SSH. ' +
        'Remote workspaces are absolute directories on the remote host; remote sessions run there and are ' +
        'stored in the remote ~/.dsh. Use action="connect" before creating sessions, action="prompt" to send a ' +
        'message, and action="wait" to collect the remote transcript. The same operations are available in the ' +
        'desktop sidebar (🌐 SSH 远程).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list_hosts',
              'add_host',
              'remove_host',
              'test_host',
              'connect',
              'disconnect',
              'browse',
              'list_workspaces',
              'add_workspace',
              'rename_workspace',
              'remove_workspace',
              'list_remote_sessions',
              'create_session',
              'resume_session',
              'close_session',
              'prompt',
              'wait',
              'cancel',
              'answer_permission',
            ],
            description: 'Operation to perform.',
          },
          hostId: { type: 'string', description: 'Host id from list_hosts/add_host.' },
          name: { type: 'string', description: 'Display name for a host or remote workspace.' },
          host: { type: 'string', description: 'Host name, IP, or ~/.ssh/config alias (add_host).' },
          user: { type: 'string', description: 'SSH user (add_host).' },
          port: { type: 'number', description: 'SSH port, default 22 (add_host).' },
          identityFile: { type: 'string', description: 'Private key path (add_host).' },
          remoteDsh: { type: 'string', description: 'Remote launcher command, default "dsh --profile acp" (add_host).' },
          dir: { type: 'string', description: 'Absolute remote directory (browse, add_workspace).' },
          workspaceId: { type: 'string', description: 'Remote workspace id.' },
          sessionId: { type: 'string', description: 'Remote session id.' },
          cwd: { type: 'string', description: 'Absolute remote directory (resume_session).' },
          title: { type: 'string', description: 'Session title.' },
          text: { type: 'string', description: 'User message to send to the remote agent (prompt).' },
          since: { type: 'number', description: 'Transcript cursor returned by a previous wait/poll (wait).' },
          timeoutMs: { type: 'number', description: 'Wait budget in milliseconds (wait).' },
          optionId: { type: 'string', description: 'Permission option id (answer_permission); "__cancel__" denies.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 16 * 60 * 1000,
      async execute(args) {
        return toLossless(await dispatchTool(args));
      },
    });

    async function dispatchTool(args) {
        const input = args && typeof args === 'object' ? args : {};
        const action = String(input.action || '');
        switch (action) {
          case 'list_hosts':
            return { hosts: service.listHosts() };
          case 'add_host':
            return { host: await service.addHost(input) };
          case 'remove_host':
            return await service.removeHost({ id: input.hostId });
          case 'test_host':
            return await service.testHost({ id: input.hostId });
          case 'connect':
            return await service.connect(String(input.hostId));
          case 'disconnect':
            return await service.disconnect(String(input.hostId));
          case 'browse':
            return await service.browseRemote({ hostId: input.hostId, dir: input.dir });
          case 'list_workspaces':
            return { workspaces: service.listWorkspaces() };
          case 'add_workspace':
            return { workspace: await service.addWorkspace({ hostId: input.hostId, dir: input.dir, name: input.name }) };
          case 'rename_workspace':
            return { workspace: await service.renameWorkspace({ id: input.workspaceId, name: input.name }) };
          case 'remove_workspace':
            return await service.removeWorkspace({ id: input.workspaceId });
          case 'list_remote_sessions':
            return { sessions: await service.listRemoteSessions({ hostId: input.hostId }) };
          case 'create_session':
            return { session: await service.createSession({ workspaceId: input.workspaceId, title: input.title }) };
          case 'resume_session':
            return {
              session: await service.resumeSession({
                hostId: input.hostId,
                sessionId: input.sessionId,
                cwd: input.cwd,
                title: input.title,
              }),
            };
          case 'close_session':
            return await service.closeSession({ sessionId: input.sessionId });
          case 'prompt':
            return await service.promptSession({ sessionId: input.sessionId, text: input.text });
          case 'wait':
            return await service.waitForSession({
              sessionId: input.sessionId,
              since: input.since,
              timeoutMs: input.timeoutMs,
            });
          case 'cancel':
            return service.cancelSession({ sessionId: input.sessionId });
          case 'answer_permission':
            return service.answerPermission({ sessionId: input.sessionId, optionId: input.optionId });
          default:
            throw fail('未知 action: ' + action);
        }
    }

    log('已注册 ssh_remote 工具');
    return () => {
      try { dispose(); } catch { /* ignore */ }
    };
  }, 'ssh-remotes.tools');

  log('SSH 远程 Host 半已挂载');
}

export const name = 'ssh-remotes';
