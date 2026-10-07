/**
 * Client half of the SSH-remote plugin.
 *
 * Registers three things into the shipped Harness Web UI:
 *  - `sidebar.panellist` id `ssh-remote`  — the sidebar globe button; the
 *    sidebar owns the button and dispatches the matching `main` panel.
 *  - `main` key `ssh-remote`              — the remote workspace/session panel
 *    plus the remote conversation.
 *  - `settings.section` id `ssh-remote`   — full SSH host management page.
 *
 * Only `react` / `react/jsx-runtime` may be required. Harness client packages
 * are deliberately not imported (they change without notice and are not part of
 * a plain-JS plugin's contract); styling uses `--dsw-alias-*` theme tokens only.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-ssh-remotes',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const REMOTE_EMOJI = '\u{1F310}'; // 🌐 network globe: the remote marker
    const POLL_MS = 900;

    // ---------------------------------------------------------------------
    // Host RPC
    // ---------------------------------------------------------------------

    async function rpc(action, payload) {
      const response = await fetch('/ssh-remote/rpc', {
        method: 'POST',
        // The custom header + JSON content type are required by the Host's
        // guard: both force a CORS preflight, which a foreign page cannot pass.
        headers: { 'content-type': 'application/json', 'x-dsh-ssh-remote': '1' },
        credentials: 'same-origin',
        body: JSON.stringify({ action, payload: payload || {} }),
      });
      if (!response.ok) {
        throw new Error('本机 SSH 服务返回 HTTP ' + response.status);
      }
      const text = await response.text();
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        throw new Error('本机 SSH 服务返回了非 JSON 响应（路由可能被鉴权拦截）');
      }
      if (!frame.ok) throw new Error(frame.error || '操作失败');
      return frame.value;
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------

    function GlobeIcon({ size }) {
      const edge = size || 16;
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('ellipse', { cx: 12, cy: 12, rx: 4, ry: 9 }),
        h('path', { d: 'M3.4 9h17.2M3.4 15h17.2' }),
      );
    }

    function RemoteBadge({ title }) {
      return h(
        'span',
        {
          title: title || '远程（SSH）',
          'aria-label': title || '远程（SSH）',
          style: { fontSize: 13, lineHeight: 1, flex: '0 0 auto' },
        },
        REMOTE_EMOJI,
      );
    }

    // ---------------------------------------------------------------------
    // Small UI atoms
    // ---------------------------------------------------------------------

    const S = {
      button: {
        font: 'inherit',
        fontSize: 12.5,
        padding: '5px 10px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      // Accent-outline, never accent-filled: `--dsw-alias-brand-primary` is a
      // *foreground* accent, and in the dark theme it resolves near-white
      // (#F9FAFB), so a filled button with a literal white label renders
      // white-on-white. Outlining keeps the accent while the surface stays a
      // token that is guaranteed to contrast with it in both themes.
      buttonPrimary: {
        font: 'inherit',
        fontSize: 12.5,
        padding: '5px 12px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-brand-primary)',
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonDanger: {
        font: 'inherit',
        fontSize: 12,
        padding: '4px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        cursor: 'pointer',
      },
      input: {
        font: 'inherit',
        fontSize: 12.5,
        padding: '6px 8px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        width: '100%',
        boxSizing: 'border-box',
      },
      label: {
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
        display: 'block',
        marginBottom: 4,
      },
      sectionTitle: {
        fontSize: 11,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
        margin: '14px 0 6px',
      },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5 },
    };

    function Button({ children, onClick, kind, disabled, title, ...rest }) {
      const base = kind === 'primary' ? S.buttonPrimary : kind === 'danger' ? S.buttonDanger : S.button;
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          title,
          // Forward the rest so accessibility attributes such as aria-label
          // reach the element instead of being silently dropped.
          ...rest,
          style: { ...base, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' },
        },
        children,
      );
    }

    function StatusDot({ status }) {
      const color =
        status === 'connected'
          ? 'var(--dsw-alias-state-success-primary)'
          : status === 'connecting' || status === 'running'
            ? 'var(--dsw-alias-state-warn-primary)'
            : status === 'error' || status === 'disconnected'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-state-idle-primary)';
      return h('span', {
        style: { width: 7, height: 7, borderRadius: 4, background: color, flex: '0 0 auto' },
      });
    }

    function Banner({ level, children, onDismiss }) {
      const color =
        level === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : level === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-state-success-primary)';
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            fontSize: 12,
            padding: '7px 9px',
            borderRadius: 8,
            border: '1px solid ' + color,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-2)',
            margin: '6px 0',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          },
        },
        h('span', { style: { color, flex: '0 0 auto' } }, '\u25CF'),
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, children),
        onDismiss ? h(Button, { onClick: onDismiss }, '\u00D7') : null,
      );
    }

    function Modal({ title, children, onClose, width }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);
      return h(
        'div',
        {
          role: 'dialog',
          'aria-modal': true,
          'aria-label': title,
          style: {
            position: 'fixed',
            inset: 0,
            // Host overlays sit at 100/1000/1100, so a modal below that had its
            // own tooltips and menus painted over it.
            zIndex: 1200,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          {
            style: {
              width: width || 520,
              maxWidth: '100%',
              maxHeight: '80vh',
              overflow: 'auto',
              background: 'var(--dsw-alias-bg-overlay)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 12,
              padding: 16,
              boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', marginBottom: 10 } },
            h('div', { style: { fontSize: 14, fontWeight: 600, flex: 1 } }, title),
            h(Button, { onClick: onClose, title: '关闭', 'aria-label': '关闭对话框' }, '\u2715'),
          ),
          children,
        ),
      );
    }

    function Field({ label, children }) {
      return h('div', { style: { marginBottom: 9 } }, h('label', { style: S.label }, label), children);
    }

    // ---------------------------------------------------------------------
    // Host form
    // ---------------------------------------------------------------------

    const EMPTY_HOST = {
      name: '',
      host: '',
      user: '',
      port: 22,
      identityFile: '',
      remoteDsh: 'dsh --profile acp',
      defaultDir: '',
    };

    function HostForm({ initial, onCancel, onSubmit, busy }) {
      const [draft, setDraft] = useState({ ...EMPTY_HOST, ...(initial || {}) });
      const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 } },
          h(Field, { label: '名称（显示用；填多个地址时会按地址命名）' }, h('input', { style: S.input, value: draft.name, onChange: set('name'), placeholder: 'devhost' })),
          h(
            Field,
            { label: '地址（可填多个：空格 / 逗号 / 换行分隔，作为同一台机器的多个入口）' },
            h('input', {
              style: S.input,
              value: draft.host,
              onChange: set('host'),
              placeholder: '192.168.1.10 100.64.0.2  或  devbox 或 user@10.0.0.5',
            }),
          ),
          h(Field, { label: '用户名（可留空）' }, h('input', { style: S.input, value: draft.user, onChange: set('user'), placeholder: 'devuser' })),
          h(Field, { label: '端口' }, h('input', { style: S.input, value: draft.port, onChange: set('port'), placeholder: '22' })),
          h(Field, { label: '私钥文件（可留空，走 ssh-agent / config）' }, h('input', { style: S.input, value: draft.identityFile, onChange: set('identityFile'), placeholder: 'C:/Users/me/.ssh/id_ed25519' })),
          h(Field, { label: '远程 dsh 启动命令' }, h('input', { style: S.input, value: draft.remoteDsh, onChange: set('remoteDsh'), placeholder: 'dsh --profile acp' })),
          h(Field, { label: '默认远程目录（可留空）' }, h('input', { style: S.input, value: draft.defaultDir, onChange: set('defaultDir'), placeholder: '~/projects 或 /srv/app' })),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 } },
          h(Button, { onClick: onCancel }, '取消'),
          h(
            Button,
            {
              kind: 'primary',
              disabled: busy || !draft.host.trim(),
              onClick: () => onSubmit({ ...draft, port: Number(draft.port) || 22 }),
            },
            busy ? '保存中…' : '保存',
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Remote directory picker
    // ---------------------------------------------------------------------

    function DirectoryPicker({ hostId, hostName, initialDir, onCancel, onPick }) {
      const [dir, setDir] = useState(initialDir || '~');
      const [listing, setListing] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      // The label is the operator's. It follows the directory only until they
      // type something, so navigating never overwrites a name they chose.
      const [name, setName] = useState('');
      const nameTouchedRef = useRef(false);

      const suggestName = (cwd) => {
        if (!cwd) return '';
        const trimmed = cwd.replace(/\/+$/, '');
        return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || cwd;
      };

      const load = useCallback(
        async (target) => {
          setBusy(true);
          setError('');
          try {
            const value = await rpc('host.browse', { hostId, dir: target });
            setListing(value);
            setDir(value.cwd);
            if (!nameTouchedRef.current) setName(suggestName(value.cwd));
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        },
        [hostId],
      );

      useEffect(() => {
        load(initialDir || '~');
      }, [load, initialDir]);

      const parent = listing && listing.cwd !== '/' ? listing.cwd.replace(/\/[^/]+\/?$/, '') || '/' : null;

      return h(
        Modal,
        { title: REMOTE_EMOJI + ' 选择 ' + hostName + ' 上的目录', onClose: onCancel, width: 640 },
        h(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 } },
          parent ? h(Button, { onClick: () => load(parent), disabled: busy }, '\u2191 上级') : null,
          h('code', { style: { ...S.mono, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, listing ? listing.cwd : dir),
        ),
        error ? h(Banner, { level: 'error' }, error) : null,
        h(
          'div',
          { style: { maxHeight: 320, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 } },
          busy && !listing
            ? h('div', { style: { padding: 12, ...S.muted } }, '读取中…')
            : (listing ? listing.entries.filter((entry) => entry.dir) : []).map((entry) =>
                h(
                  'button',
                  {
                    key: entry.name,
                    type: 'button',
                    onClick: () => load(listing.cwd.replace(/\/$/, '') + '/' + entry.name),
                    style: {
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 10px',
                      border: 'none',
                      borderBottom: '1px solid var(--dsw-alias-border-l1)',
                      background: 'transparent',
                      color: 'var(--dsw-alias-label-primary)',
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 12.5,
                    },
                  },
                  h('span', null, '\u{1F4C1}'),
                  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, entry.name),
                ),
              ),
          listing && listing.entries.filter((entry) => entry.dir).length === 0 && !busy
            ? h('div', { style: { padding: 12, ...S.muted } }, '没有子目录')
            : null,
        ),
        h(
          'div',
          { style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
          h(Field, { label: '工作区名称（可自定义，留空则用目录名）' },
            h('input', {
              style: S.input,
              value: name,
              maxLength: 80,
              placeholder: suggestName(listing ? listing.cwd : dir),
              onChange: (event) => {
                nameTouchedRef.current = true;
                setName(event.target.value);
              },
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' } },
            h('code', { style: { ...S.mono, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              listing ? listing.cwd : dir),
            h(Button, { onClick: onCancel }, '取消'),
            h(
              Button,
              {
                kind: 'primary',
                disabled: busy || !listing,
                onClick: () => listing && onPick(listing.cwd, name.trim()),
              },
              '创建远程工作区',
            ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Conversation
    // ---------------------------------------------------------------------

    function toolLine(item) {
      const status = item.status || '';
      const mark = status === 'completed' || status === 'succeeded' ? '\u2713' : status === 'failed' ? '\u2717' : '\u22EF';
      return mark + ' ' + (item.title || '工具调用') + (status ? '  [' + status + ']' : '');
    }

    /** Flatten an ACP content block list into displayable text. */
    function toolDetail(item) {
      const parts = [];
      const blocks = Array.isArray(item.content) ? item.content : [];
      for (const block of blocks) {
        if (!block) continue;
        if (block.type === 'content' && block.content && block.content.type === 'text') parts.push(block.content.text);
        else if (block.type === 'text' && block.text) parts.push(block.text);
        else if (block.type === 'diff') parts.push((block.path || 'diff') + '\n' + String(block.newText || '').slice(0, 2000));
        else if (block.type === 'terminal') parts.push('$ ' + (block.command || '') + '\n' + String(block.output || '').slice(0, 2000));
        else if (typeof block.text === 'string') parts.push(block.text);
      }
      if (item.rawOutput && typeof item.rawOutput === 'string') parts.push(item.rawOutput);
      else if (item.rawOutput) parts.push(typeof item.rawOutput === 'object' && item.rawOutput.text ? item.rawOutput.text : JSON.stringify(item.rawOutput));
      if (parts.length === 0 && item.rawInput) {
        parts.push('参数: ' + (typeof item.rawInput === 'string' ? item.rawInput : JSON.stringify(item.rawInput)));
      }
      const text = parts.filter(Boolean).join('\n').trim();
      return text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text;
    }

    function TranscriptItem({ item }) {
      if (item.kind === 'user') {
        return h(
          'div',
          {
            style: {
              alignSelf: 'flex-end',
              maxWidth: '82%',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 10,
              padding: '8px 11px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 13,
            },
          },
          item.text,
        );
      }
      if (item.kind === 'assistant') {
        return h(
          'div',
          { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.55 } },
          item.text,
        );
      }
      if (item.kind === 'thought') {
        return h(
          'div',
          { style: { ...S.muted, whiteSpace: 'pre-wrap', borderLeft: '2px solid var(--dsw-alias-border-l2)', paddingLeft: 8 } },
          item.text,
        );
      }
      if (item.kind === 'tool') {
        // The Host sends the tool's content/rawOutput; showing only the title
        // hid every result from the user.
        const detail = toolDetail(item);
        return h(
          'div',
          {
            style: {
              ...S.mono,
              padding: '6px 9px',
              borderRadius: 7,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          toolLine(item),
          detail
            ? h(
                'div',
                {
                  style: {
                    marginTop: 5,
                    paddingTop: 5,
                    borderTop: '1px solid var(--dsw-alias-border-l1)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 260,
                    overflow: 'auto',
                    color: 'var(--dsw-alias-label-primary)',
                  },
                },
                detail,
              )
            : null,
        );
      }
      if (item.kind === 'permission') {
        return h(
          'div',
          {
            style: {
              fontSize: 12,
              padding: '6px 9px',
              borderRadius: 7,
              border: '1px dashed var(--dsw-alias-state-warn-primary)',
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          '\u{1F510} 远程请求授权: ' + item.title,
        );
      }
      if (item.kind === 'turn') {
        return h('div', { style: { ...S.muted, fontSize: 11 } }, '\u2014 回合结束 (' + item.stopReason + ') \u2014');
      }
      if (item.kind === 'notice') {
        return h(Banner, { level: item.level || 'info' }, item.text);
      }
      if (item.kind === 'plan') {
        return h(
          'div',
          { style: { fontSize: 12, padding: '6px 9px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l1)' } },
          (item.entries || []).map((entry, index) =>
            h('div', { key: index }, entry.status + ' — ' + entry.content),
          ),
        );
      }
      return null;
    }

    function PermissionPrompt({ sessionId, pending, onAnswered }) {
      const [busy, setBusy] = useState('');
      if (!pending) return null;
      const answer = async (optionId) => {
        setBusy(optionId);
        try {
          await rpc('permission.answer', { sessionId, optionId });
          onAnswered && onAnswered();
        } catch (error) {
          onAnswered && onAnswered(error.message);
        } finally {
          setBusy('');
        }
      };
      return h(
        'div',
        {
          style: {
            border: '1px solid var(--dsw-alias-state-warn-primary)',
            borderRadius: 9,
            padding: 10,
            margin: '8px 0',
            background: 'var(--dsw-alias-bg-layer-2)',
          },
        },
        h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4 } }, '\u{1F510} 远程主机请求授权'),
        h(
          'div',
          { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } },
          '请确认下面这次远程操作，批准后它将在服务器上执行。',
        ),
        h('div', { style: { fontSize: 12, marginBottom: 6 } }, pending.title),
        pending.detail || pending.rawInput
          ? h(
              'pre',
              {
                style: {
                  ...S.mono,
                  margin: '0 0 8px',
                  padding: 8,
                  maxHeight: 180,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: 'var(--dsw-alias-bg-base)',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: 6,
                },
              },
              pending.detail
                || (() => {
                  try {
                    return JSON.stringify(pending.rawInput, null, 2);
                  } catch {
                    return String(pending.rawInput);
                  }
                })(),
            )
          : h(
              'div',
              { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 8 } },
              '远程未提供该操作的详细信息，请谨慎批准。',
            ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          pending.options.map((option) =>
            h(
              Button,
              {
                key: option.optionId,
                kind: /allow/i.test(option.kind || '') ? 'primary' : undefined,
                disabled: Boolean(busy),
                onClick: () => answer(option.optionId),
              },
              option.name + (busy === option.optionId ? ' …' : ''),
            ),
          ),
          h(Button, { kind: 'danger', disabled: Boolean(busy), onClick: () => answer('__cancel__') }, '拒绝'),
        ),
      );
    }

    function Conversation({ session, hostName }) {
      const [items, setItems] = useState([]);
      const [pendingPermission, setPendingPermission] = useState(null);
      const [status, setStatus] = useState(session.status);
      const [busy, setBusy] = useState(session.busy);
      const [draft, setDraft] = useState('');
      const [error, setError] = useState('');
      const seqRef = useRef(0);
      const scrollRef = useRef(null);
      const stickRef = useRef(true);

      const sessionId = session.sessionId;

      // Merge by item id: the Host re-delivers an item whose text grew in place
      // (streaming chunks re-use one item), so appending would duplicate it and
      // ignoring it would freeze the row at its first chunk.
      const mergeItems = (current, incoming) => {
        const next = [...current];
        const index = new Map(next.map((item, position) => [item.id || item.seq, position]));
        for (const item of incoming) {
          const key = item.id || item.seq;
          const position = index.get(key);
          if (position === undefined) {
            index.set(key, next.length);
            next.push(item);
          } else {
            next[position] = item;
          }
        }
        return next;
      };

      useEffect(() => {
        setItems([]);
        setPendingPermission(null);
        setError('');
        seqRef.current = 0;
        let cancelled = false;
        let timer = null;

        const tick = async () => {
          try {
            const value = await rpc('session.poll', { sessionId, since: seqRef.current });
            if (cancelled) return;
            if (value.missing) {
              setError('该会话已不在本机跟踪列表中');
            } else {
              if (value.items && value.items.length) {
                seqRef.current = Math.max(seqRef.current, Number(value.seq) || 0);
                setItems((current) => mergeItems(current, value.items));
              } else if (typeof value.seq === 'number') {
                seqRef.current = Math.max(seqRef.current, value.seq);
              }
              setStatus(value.status);
              setBusy(Boolean(value.busy));
              setPendingPermission(value.pendingPermission || null);
            }
          } catch (err) {
            if (!cancelled) setError(err.message);
          } finally {
            if (!cancelled) timer = setTimeout(tick, POLL_MS);
          }
        };
        tick();
        return () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
        };
      }, [sessionId]);

      useEffect(() => {
        const node = scrollRef.current;
        if (node && stickRef.current) node.scrollTop = node.scrollHeight;
      }, [items, pendingPermission]);

      const submit = async () => {
        const text = draft.trim();
        // Ctrl/Cmd+Enter reaches here too, so guard `busy` here rather than only
        // on the button — otherwise the same prompt is sent twice.
        if (!text || busy) return;
        stickRef.current = true;
        try {
          await rpc('session.prompt', { sessionId, text });
          // Clear only after the Host accepted it: clearing first silently threw
          // away the user's typed prompt whenever the send was rejected.
          setDraft('');
        } catch (err) {
          setError(err.message);
        }
      };

      const cancel = async () => {
        try {
          await rpc('session.cancel', { sessionId });
        } catch (err) {
          setError(err.message);
        }
      };

      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: '9px 14px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            flex: '0 0 auto',
          },
        },
        h(RemoteBadge, null),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, session.title),
          h('div', { style: { ...S.muted, ...S.mono } }, hostName + ':' + session.cwd),
        ),
        h(StatusDot, { status }),
        h('span', { style: { ...S.muted, fontSize: 11 } }, status + (busy ? ' / 运行中' : '')),
        busy ? h(Button, { onClick: cancel }, '取消回合') : null,
      );

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, flex: 1 } },
        header,
        h(
          'div',
          {
            ref: scrollRef,
            onScroll: (event) => {
              const node = event.currentTarget;
              stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
            },
            style: { flex: 1, overflow: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9 },
          },
          items.length === 0 && !busy
            ? h(
                'div',
                { style: { ...S.muted, textAlign: 'center', marginTop: 40 } },
                REMOTE_EMOJI + ' 远程会话已就绪',
                h('div', { style: { marginTop: 6 } }, '输入消息后将在远程主机 ' + hostName + ' 上执行。'),
                h('div', { style: { marginTop: 6, fontSize: 11 } }, '（ACP 不重放历史；恢复的会话从新的回合开始显示。）'),
              )
            : items.map((item) => h(TranscriptItem, { key: item.id || item.seq, item })),
          h(PermissionPrompt, {
            sessionId,
            pending: pendingPermission,
            onAnswered: (message) => {
              if (typeof message === 'string') setError(message);
            },
          }),
          error ? h(Banner, { level: 'error', onDismiss: () => setError('') }, error) : null,
        ),
        h(
          'div',
          { style: { flex: '0 0 auto', borderTop: '1px solid var(--dsw-alias-border-l1)', padding: 10 } },
          h('textarea', {
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            },
            'aria-label': '发送到远程 dsh 的消息',
            placeholder: '发送到远程 dsh…（Ctrl/Cmd+Enter 发送）',
            rows: 3,
            style: { ...S.input, resize: 'vertical', fontFamily: 'inherit' },
          }),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 7 } },
            h('span', { style: { ...S.muted, fontSize: 11 } }, 'Ctrl/Cmd+Enter 发送'),
            h(Button, { kind: 'primary', disabled: busy || !draft.trim(), onClick: submit }, busy ? '远程运行中…' : '发送'),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Main panel: hosts + workspaces + sessions
    // ---------------------------------------------------------------------

    function RemoteTree({
      state,
      selectedSessionId,
      onSelectSession,
      reload,
      notify,
    }) {
      const [expanded, setExpanded] = useState({});
      const [addHost, setAddHost] = useState(false);
      const [editingHost, setEditingHost] = useState(null);
      // Connection details copied from an existing route when adding another
      // route to the same machine ("+ 入口"): only the address is left blank.
      const [prefill, setPrefill] = useState(null);
      // Bumped on every open so the form always remounts with a fresh draft.
      const [formNonce, setFormNonce] = useState(0);
      const openForm = (options) => {
        const next = options || {};
        setEditingHost(next.editing || null);
        setPrefill(next.prefill || null);
        setAddHost(true);
        setFormNonce((value) => value + 1);
      };
      const [busyAction, setBusyAction] = useState('');
      const [picker, setPicker] = useState(null);
      const [remoteSessions, setRemoteSessions] = useState({});
      // Id of the host/workspace awaiting a second click before it is removed.
      // Removing a host also drops every remote workspace recorded under it, so
      // a single misclick must not do it.
      const [confirming, setConfirming] = useState(null);
      // Inline workspace rename: { id, value } while an input is open.
      const [renaming, setRenaming] = useState(null);
      // Enter commits and then the input unmounts, which can fire onBlur with
      // the pre-update closure. This makes the commit idempotent per edit.
      const renameGuardRef = useRef(null);

      const startRename = (workspace) => {
        renameGuardRef.current = workspace.id;
        setRenaming({ id: workspace.id, value: workspace.name });
      };

      const commitRename = (workspace) => {
        if (renameGuardRef.current !== workspace.id) return;
        renameGuardRef.current = null;
        const next = ((renaming && renaming.value) || '').trim();
        setRenaming(null);
        if (!next || next === workspace.name) return;
        act('ren-' + workspace.id, 'workspace.rename', { id: workspace.id, name: next }, '已重命名为 ' + next)
          .catch(() => {});
      };

      // An armed confirmation reverts on its own so a stray first click cannot
      // leave a destructive control primed indefinitely.
      useEffect(() => {
        if (!confirming) return undefined;
        const timer = setTimeout(() => setConfirming(null), 8000);
        return () => clearTimeout(timer);
      }, [confirming]);

      const toggle = (id) => setExpanded((current) => ({ ...current, [id]: !current[id] }));

      const act = async (key, action, payload, okMessage) => {
        setBusyAction(key);
        try {
          const value = await rpc(action, payload);
          if (okMessage) notify('info', okMessage);
          await reload();
          return value;
        } catch (error) {
          notify('error', error.message);
          throw error;
        } finally {
          setBusyAction('');
        }
      };

      // Saved-session lists belong to the machine, not to one route into it.
      const loadRemoteSessions = async (machineKey) => {
        try {
          const value = await rpc('session.listRemote', { machineKey, refresh: true });
          setRemoteSessions((current) => ({ ...current, [machineKey]: value.sessions }));
        } catch (error) {
          notify('error', error.message);
        }
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          h('div', { style: { fontSize: 12, fontWeight: 600, flex: 1 } }, '远程主机'),
          h(Button, { onClick: () => openForm() }, '+ 主机'),
        ),
        h(
          'div',
          { style: { flex: 1, overflow: 'auto', padding: '6px 8px' } },
          addHost || editingHost
            ? h(
                'div',
                { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 9, padding: 10, marginBottom: 8 } },
                h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 8 } }, editingHost ? '编辑入口' : '新增 SSH 入口'),
                h(HostForm, {
                  // Without a key React reuses this instance when the edit
                  // target changes, so the PREVIOUS host's draft would be shown
                  // and saving it would silently overwrite the wrong record.
                  key: 'hostform-' + formNonce,
                  initial: editingHost || prefill || undefined,
                  busy: Boolean(busyAction),
                  onCancel: () => { setAddHost(false); setEditingHost(null); setPrefill(null); },
                  onSubmit: async (value) => {
                    try {
                      if (editingHost) {
                        // Editing one existing route: its address stays single.
                        await act('save', 'host.update', { ...value, id: editingHost.id }, '入口已更新');
                      } else {
                        // One address per record. Several addresses in one go
                        // simply create several routes; they merge into one
                        // machine node once each reports its fingerprint.
                        const addresses = String(value.host || '')
                          .split(/[\s,;，、]+/)
                          .map((item) => item.trim())
                          .filter(Boolean);
                        if (addresses.length === 0) throw new Error('地址不能为空');
                        for (const address of addresses) {
                          await act(
                            'save',
                            'host.add',
                            {
                              ...value,
                              host: address,
                              name: addresses.length > 1 ? address : value.name || address,
                            },
                            null,
                          );
                        }
                        notify('info', addresses.length > 1
                          ? '已添加 ' + addresses.length + ' 个入口，连接后会自动归并到同一台机器'
                          : '入口已添加，请点击连接');
                      }
                      setAddHost(false);
                      setEditingHost(null);
                      setPrefill(null);
                    } catch (error) {
                      notify('error', error.message);
                    }
                  },
                }),
              )
            : null,

          state.hosts.length === 0 && !addHost
            ? h(
                'div',
                { style: { ...S.muted, padding: 12, textAlign: 'center' } },
                REMOTE_EMOJI + ' 还没有配置 SSH 远程主机',
                h('div', { style: { marginTop: 6, fontSize: 11.5 } }, '点击右上角 “+ 主机” 添加。主机需已配置免密登录（公钥或 ssh-agent）。'),
              )
            : (state.machines || []).map((machine) => {
                // A machine is one node; the routes that reach it (LAN,
                // Tailscale…) are endpoints underneath, so both share one
                // workspace/session tree instead of duplicating it.
                const endpoint = machine.endpoints.find((item) => item.id === machine.endpointId) || machine.endpoints[0];
                const endpointRecord = state.hosts.find((item) => item.id === endpoint.id) || endpoint;
                const workspaces = state.workspaces.filter((workspace) => workspace.machineKey === machine.machineKey);
                const sessionsForMachine = state.sessions.filter((session) => session.machineKey === machine.machineKey);
                const list = remoteSessions[machine.machineKey];
                const open = expanded[machine.machineKey];
                return h(
                  'div',
                  { key: machine.machineKey, style: { marginBottom: 6 } },
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 7px',
                        borderRadius: 7,
                        background: open ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                      },
                    },
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => toggle(machine.machineKey),
                        style: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', font: 'inherit', padding: 0, width: 12 },
                      },
                      open ? '\u25BE' : '\u25B8',
                    ),
                    h(StatusDot, { status: machine.connected ? 'connected' : machine.error ? 'error' : 'idle' }),
                    h(
                      'div',
                      { style: { flex: 1, minWidth: 0, cursor: 'pointer' }, onClick: () => toggle(machine.machineKey) },
                      h('div', { style: { fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, machine.label),
                      h('div', { style: { ...S.muted, ...S.mono, fontSize: 10.5 } },
                        machine.endpoints.map((item) => item.host).join('  \u00B7  ')),
                    ),
                    endpoint.connected
                      ? h(Button, { disabled: busyAction === 'conn-' + endpoint.id, onClick: () => act('conn-' + endpoint.id, 'host.disconnect', { id: endpoint.id }, '已断开 ' + endpoint.name) }, '断开')
                      : h(Button, { kind: 'primary', disabled: busyAction === 'conn-' + endpoint.id, onClick: () => act('conn-' + endpoint.id, 'host.connect', { id: endpoint.id }, '已连接 ' + endpoint.name).then(() => loadRemoteSessions(machine.machineKey)).catch(() => {}) }, busyAction === 'conn-' + endpoint.id ? '连接中…' : '连接'),
                  ),
                  machine.endpoints.length > 1
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', paddingLeft: 18, marginBottom: 4 } },
                        machine.endpoints.map((item) =>
                          h(
                            'span',
                            { key: item.id, style: { display: 'inline-flex', alignItems: 'center', gap: 2 } },
                            h(
                              'button',
                              {
                                type: 'button',
                                // Ignore clicks while this route's connection
                                // action is in flight: a double-click used to
                                // fire connect then disconnect against a
                                // connection that had just become live, leaving
                                // the remote dsh process orphaned.
                                disabled: busyAction === 'conn-' + item.id,
                                title: (item.connected ? '断开 ' : '连接 ') +
                                  (item.user ? item.user + '@' : '') + item.host + ':' + item.port,
                                onClick: () => {
                                  if (busyAction === 'conn-' + item.id) return;
                                  act('conn-' + item.id, item.connected ? 'host.disconnect' : 'host.connect', { id: item.id },
                                    (item.connected ? '已断开 ' : '已连接 ') + item.name).catch(() => {});
                                },
                                style: {
                                  display: 'inline-flex', alignItems: 'center', gap: 5, font: 'inherit', fontSize: 10.5,
                                  padding: '2px 7px', borderRadius: 999,
                                  cursor: busyAction === 'conn-' + item.id ? 'default' : 'pointer',
                                  opacity: busyAction === 'conn-' + item.id ? 0.5 : 1,
                                  border: '1px solid var(--dsw-alias-border-l2)',
                                  background: item.connected ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                                  color: 'var(--dsw-alias-label-secondary)',
                                },
                              },
                              h(StatusDot, { status: item.connected ? 'connected' : item.status }),
                              item.name,
                            ),
                            // Every route is editable on its own, so changing just
                            // the Tailscale address never touches the LAN one.
                            h(
                              Button,
                              {
                                title: '编辑入口 ' + item.host,
                                'aria-label': '编辑入口 ' + item.host,
                                disabled: Boolean(renaming),
                                onClick: () => {
                                  const record = state.hosts.find((candidate) => candidate.id === item.id) || item;
                                  openForm({ editing: record });
                                },
                              },
                              '\u270E',
                            ),
                          )),
                      )
                    : null,
                  machine.error && !machine.connected
                    ? h(Banner, { level: 'error' }, machine.error)
                    : null,
                  open
                    ? h(
                        'div',
                        { style: { paddingLeft: 18, marginTop: 2 } },
                        h(
                          'div',
                          { style: { display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' } },
                          h(
                            Button,
                            {
                              disabled: !endpoint.connected,
                              onClick: () => setPicker({ hostId: endpoint.id, hostName: endpoint.name, initialDir: endpoint.defaultDir || '~' }),
                            },
                            REMOTE_EMOJI + ' 新建远程工作区',
                          ),
                          h(Button, { disabled: !endpoint.connected, onClick: () => loadRemoteSessions(machine.machineKey) }, '刷新远程会话'),
                          h(Button, { onClick: () => act('test-' + endpoint.id, 'host.test', { id: endpoint.id }).then((r) => notify(r.ok ? 'info' : 'error', r.message)).catch(() => {}) }, busyAction === 'test-' + endpoint.id ? '测试中…' : '测试'),
                          h(Button, { onClick: () => openForm({ editing: endpointRecord }) }, '编辑'),
                          h(
                            Button,
                            {
                              title: '给这台机器再加一个入口（例如新增/更换 Tailscale 地址）：其余字段沿用当前入口，只填地址',
                              onClick: () =>
                                openForm({
                                  prefill: {
                                    name: '',
                                    host: '',
                                    user: endpointRecord.user || '',
                                    port: endpointRecord.port || 22,
                                    identityFile: endpointRecord.identityFile || '',
                                    remoteDsh: endpointRecord.remoteDsh || 'dsh --profile acp',
                                    defaultDir: endpointRecord.defaultDir || '',
                                  },
                                }),
                            },
                            '+ 入口',
                          ),
                          h(
                            Button,
                            {
                              kind: 'danger',
                              title: machine.endpoints.length > 1
                                ? '删除该入口；机器仍由另一个入口可达时，其工作区与记录会保留'
                                : '删除该入口及其机器下的全部远程工作区记录',
                              disabled: confirming === 'host:' + endpoint.id,
                              onClick: () => setConfirming('host:' + endpoint.id),
                            },
                            '删除',
                          ),
                          confirming === 'host:' + endpoint.id
                            ? h(
                                'span',
                                { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
                                h(
                                  Button,
                                  {
                                    kind: 'danger',
                                    title: '确认删除该入口',
                                    onClick: () => {
                                      setConfirming(null);
                                      act('del-' + endpoint.id, 'host.remove', { id: endpoint.id }, '已删除 ' + endpoint.name)
                                        .catch(() => {});
                                    },
                                  },
                                  '确认删除 ' + endpoint.name + '？',
                                ),
                                h(Button, { onClick: () => setConfirming(null) }, '取消'),
                              )
                            : null,
                        ),
                        h('div', { style: S.sectionTitle }, '远程工作区'),
                        workspaces.length === 0
                          ? h('div', { style: { ...S.muted, fontSize: 11.5, marginBottom: 6 } }, '暂无，点击 “新建远程工作区” 选择远程目录')
                          : workspaces.map((workspace) =>
                              h(
                                'div',
                                { key: workspace.id, style: { marginBottom: 4 } },
                                h(
                                  'div',
                                  { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-1)' } },
                                  h(RemoteBadge, { title: '远程工作区' }),
                                  h('div', { style: { flex: 1, minWidth: 0 } },
                                    renaming && renaming.id === workspace.id
                                      ? h('input', {
                                          style: { ...S.input, fontSize: 12, padding: '2px 6px' },
                                          value: renaming.value,
                                          maxLength: 80,
                                          autoFocus: true,
                                          'aria-label': '重命名远程工作区',
                                          onChange: (event) => setRenaming({ id: workspace.id, value: event.target.value }),
                                          // Select the old label so typing replaces it — the
                                          // usual expectation for an inline rename field.
                                          onFocus: (event) => event.target.select(),
                                          onKeyDown: (event) => {
                                            if (event.key === 'Enter') {
                                              event.preventDefault();
                                              commitRename(workspace);
                                            } else if (event.key === 'Escape') {
                                              event.preventDefault();
                                              setRenaming(null);
                                            }
                                          },
                                          onBlur: () => commitRename(workspace),
                                        })
                                      : h('div', { style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, workspace.name),
                                    h('div', { style: { ...S.muted, ...S.mono, fontSize: 10.5 } }, workspace.cwd),
                                  ),
                                  h(
                                    Button,
                                    {
                                      title: '重命名该远程工作区（只改本机标签，不动服务器目录）',
                                      'aria-label': '重命名远程工作区 ' + workspace.name,
                                      disabled: Boolean(renaming),
                                      onClick: () => startRename(workspace),
                                    },
                                    '\u270E',
                                  ),
                                  h(
                                    Button,
                                    {
                                      disabled: !machine.connected,
                                      title: machine.connected
                                        ? '在该远程目录中新建会话'
                                        : '该机器的所有入口都未连接',
                                      onClick: () =>
                                        act('new-' + workspace.id, 'session.create', { workspaceId: workspace.id }, '已创建远程会话')
                                          .then((value) => onSelectSession(value.session.sessionId))
                                          .catch(() => {}),
                                    },
                                    '+ 会话',
                                  ),
                                  h(
                                    Button,
                                    {
                                      kind: 'danger',
                                      title: '从本机列表移除该远程工作区（不影响服务器上的文件）',
                                      'aria-label': '移除远程工作区 ' + workspace.name,
                                      disabled: confirming === 'ws:' + workspace.id,
                                      onClick: () => setConfirming('ws:' + workspace.id),
                                    },
                                    '\u2715',
                                  ),
                                  confirming === 'ws:' + workspace.id
                                    ? h(
                                        'span',
                                        { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
                                        h(
                                          Button,
                                          {
                                            kind: 'danger',
                                            title: '确认从本机列表移除该远程工作区',
                                            onClick: () => {
                                              setConfirming(null);
                                              act('delws-' + workspace.id, 'workspace.remove', { id: workspace.id })
                                                .catch(() => {});
                                            },
                                          },
                                          '确认移除？',
                                        ),
                                        h(Button, { onClick: () => setConfirming(null) }, '取消'),
                                      )
                                    : null,
                                ),
                                sessionsForMachine
                                  .filter((session) => session.workspaceId === workspace.id)
                                  .map((session) =>
                                    h(
                                      'button',
                                      {
                                        key: session.sessionId,
                                        type: 'button',
                                        onClick: () => onSelectSession(session.sessionId),
                                        style: {
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 6,
                                          width: '100%',
                                          textAlign: 'left',
                                          border: 'none',
                                          background: selectedSessionId === session.sessionId ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                                          color: 'var(--dsw-alias-label-primary)',
                                          font: 'inherit',
                                          fontSize: 12,
                                          padding: '4px 6px 4px 14px',
                                          borderRadius: 6,
                                          cursor: 'pointer',
                                        },
                                      },
                                      h(RemoteBadge, { title: '远程会话' }),
                                      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, session.title),
                                      h(StatusDot, { status: session.busy ? 'running' : session.status }),
                                    ),
                                  ),
                              ),
                            ),
                        list && list.length
                          ? h(
                              'div',
                              null,
                              h('div', { style: S.sectionTitle }, '远程已保存会话（可恢复）'),
                              list
                                .filter((entry) => !sessionsForMachine.some((session) => session.sessionId === entry.sessionId))
                                .slice(0, 20)
                                .map((entry) =>
                                  h(
                                    'button',
                                    {
                                      key: entry.sessionId,
                                      type: 'button',
                                      onClick: () =>
                                        act('resume-' + entry.sessionId, 'session.resume', {
                                          hostId: entry.hostId || endpoint.id,
                                          sessionId: entry.sessionId,
                                          cwd: entry.cwd,
                                        }, '已恢复远程会话')
                                          .then((value) => onSelectSession(value.session.sessionId))
                                          .catch(() => {}),
                                      style: {
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        width: '100%',
                                        textAlign: 'left',
                                        border: 'none',
                                        background: 'transparent',
                                        color: 'var(--dsw-alias-label-primary)',
                                        font: 'inherit',
                                        fontSize: 11.5,
                                        padding: '4px 6px',
                                        borderRadius: 6,
                                        cursor: 'pointer',
                                      },
                                    },
                                    h(RemoteBadge, { title: '远程会话' }),
                                    h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.sessionId.slice(-12)),
                                    h('span', { style: { ...S.muted, ...S.mono, fontSize: 10 } }, entry.cwd),
                                  ),
                                ),
                            )
                          : null,
                      )
                    : null,
                );
              }),
        ),
        picker
          ? h(DirectoryPicker, {
              hostId: picker.hostId,
              hostName: picker.hostName,
              initialDir: picker.initialDir,
              onCancel: () => setPicker(null),
              onPick: async (dir, name) => {
                try {
                  await act('addws', 'workspace.add', { hostId: picker.hostId, dir, name });
                  setPicker(null);
                  notify('info', '已添加远程工作区 ' + (name || dir));
                } catch { /* notified */ }
              },
            })
          : null,
      );
    }

    function RemotePanel() {
      const [state, setState] = useState({ hosts: [], workspaces: [], sessions: [] });
      const [selectedSessionId, setSelectedSessionId] = useState(null);
      const [notice, setNotice] = useState(null);
      const [loading, setLoading] = useState(true);

      const reload = useCallback(async () => {
        try {
          const value = await rpc('state');
          setState(value);
          return value;
        } catch (error) {
          setNotice({ level: 'error', text: error.message });
          throw error;
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        reload().catch(() => undefined);
        const timer = setInterval(() => reload().catch(() => undefined), 5000);
        return () => clearInterval(timer);
      }, [reload]);

      const notify = useCallback((level, text) => setNotice({ level, text }), []);

      const selected = useMemo(() => {
        if (!selectedSessionId) return null;
        const live = state.sessions.find((session) => session.sessionId === selectedSessionId);
        return live || null;
      }, [state.sessions, selectedSessionId]);

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: '0 0 auto' } },
          h(RemoteBadge, null),
          h('div', { style: { fontSize: 14, fontWeight: 600, flex: 1 } }, 'SSH 远程服务器'),
          h('div', { style: { ...S.muted, fontSize: 11.5 } },
            state.hosts.length + ' 台主机 · ' + state.workspaces.length + ' 个远程工作区 · ' + state.sessions.length + ' 个远程会话'),
        ),
        notice
          ? h('div', { style: { padding: '0 14px' } },
              h(Banner, { level: notice.level, onDismiss: () => setNotice(null) }, notice.text))
          : null,
        h(
          'div',
          { style: { flex: 1, display: 'flex', minHeight: 0 } },
          h(
            'div',
            {
              style: {
                width: 330,
                flex: '0 0 auto',
                borderRight: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-1)',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
              },
            },
            loading
              ? h('div', { style: { padding: 16, ...S.muted } }, '加载中…')
              : h(RemoteTree, {
                  state,
                  selectedSessionId,
                  onSelectSession: setSelectedSessionId,
                  reload,
                  notify,
                }),
          ),
          selected
            ? h(Conversation, {
                key: selected.sessionId,
                session: selected,
                hostName: selected.hostName || '',
              })
            : h(
                'div',
                { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', ...S.muted } },
                h('div', { style: { textAlign: 'center', maxWidth: 420 } },
                  h('div', { style: { fontSize: 30 } }, REMOTE_EMOJI),
                  h('div', { style: { marginTop: 8, fontSize: 13 } }, '选择或创建一个远程会话'),
                  h('div', { style: { marginTop: 6, fontSize: 12 } },
                    '远程会话运行在服务器端的无头 dsh 上（ACP 协议），本机只负责显示与驱动。'),
                ),
              ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Settings page
    // ---------------------------------------------------------------------

    function SettingsPage() {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [testResult, setTestResult] = useState(null);

      const reload = useCallback(async () => {
        try {
          setState(await rpc('state'));
        } catch (err) {
          setError(err.message);
        }
      }, []);

      useEffect(() => {
        reload();
      }, [reload]);

      if (error) return h('div', { style: { padding: 16 } }, h(Banner, { level: 'error' }, error));
      if (!state) return h('div', { style: { padding: 16, ...S.muted } }, '加载中…');

      return h(
        'div',
        { style: { padding: '4px 2px', color: 'var(--dsw-alias-label-primary)' } },
        h('div', { style: { fontSize: 13, lineHeight: 1.6, marginBottom: 10 } },
          REMOTE_EMOJI + ' 通过 SSH 连接远程服务器上以无头模式运行的 dsh（`dsh --profile acp`），',
          '在左侧边栏的 ' + REMOTE_EMOJI + ' 面板中创建远程工作区与远程会话。',
        ),
        testResult ? h(Banner, { level: testResult.ok ? 'info' : 'error', onDismiss: () => setTestResult(null) }, testResult.message) : null,
        h('div', { style: S.sectionTitle }, '已配置主机'),
        state.hosts.length === 0
          ? h('div', { style: S.muted }, '尚未配置主机。请在 ' + REMOTE_EMOJI + ' 远程面板中添加。')
          : state.hosts.map((host) =>
              h(
                'div',
                {
                  key: host.id,
                  style: { display: 'flex', gap: 8, alignItems: 'center', padding: '7px 9px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, marginBottom: 6 },
                },
                h(StatusDot, { status: host.connected ? 'connected' : host.status }),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, host.name),
                  h('div', { style: { ...S.muted, ...S.mono, fontSize: 10.5 } },
                    (host.user ? host.user + '@' : '') + host.host + ':' + host.port + '  ·  ' + host.remoteDsh),
                ),
                h(
                  Button,
                  {
                    disabled: busy === host.id,
                    onClick: async () => {
                      setBusy(host.id);
                      try {
                        setTestResult(await rpc('host.test', { id: host.id }));
                      } catch (err) {
                        setTestResult({ ok: false, message: err.message });
                      } finally {
                        setBusy('');
                      }
                    },
                  },
                  busy === host.id ? '测试中…' : '测试连接',
                ),
              ),
            ),
        h('div', { style: S.sectionTitle }, '说明'),
        h('div', { style: { ...S.muted, fontSize: 12, lineHeight: 1.7 } },
          h('div', null, '1. 远程主机需已安装 dsh，并配置好免密登录（公钥或 ssh-agent）；本插件使用 BatchMode=yes，不会弹出密码提示。'),
          h('div', null, '2. 插件在服务器端拉起 `dsh --profile acp`（无头、纯 stdio、不监听端口），首次运行会自动初始化 acp profile。'),
          h('div', null, '3. 远程工作区 = 服务器上的一个绝对目录；远程会话运行在该目录中，并保存在服务器的 ~/.dsh/sessions。'),
          h('div', null, '4. 远程授权请求会转发到这里，由你决定是否允许远程工具调用。'),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'ssh-remote',
              order: 20,
              label: () => 'SSH 远程',
            },
            ({ size, active }) =>
              h(
                'span',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
                  },
                },
                h(GlobeIcon, { size: size || 18 }),
              ),
          ),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'ssh-remote' }, RemotePanel),
        );

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'ssh-remote', order: 60, label: () => 'SSH 远程' },
            SettingsPage,
          ),
        );
      },
    };
  },
});
