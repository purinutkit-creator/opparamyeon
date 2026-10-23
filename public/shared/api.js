// Small API client shared by all pages.
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem('opp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('opp.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem('opp.' + k); } catch { /* ignore */ } },
};

export class ApiError extends Error { constructor(status, msg, code, body) { super(msg); this.status = status; this.code = code; this.body = body; } }

export function makeApi({ tokenKey = 'staff_token', extraHeaders = () => ({}), onUnauthorized = null } = {}) {
  const api = async (method, path, body, opts = {}) => {
    const h = { ...extraHeaders(), ...(opts.headers || {}) };
    const tok = opts.token !== undefined ? opts.token : store.get(tokenKey);
    if (tok) h.Authorization = 'Bearer ' + tok;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try { res = await fetch('/api' + path, { method, headers: h, body: payload, signal: opts.signal }); }
    catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError(0, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต', 'offline'); }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      if (res.status === 401 && onUnauthorized) onUnauthorized();
      throw new ApiError(res.status, (data && data.error) || 'เกิดข้อผิดพลาด', data && data.code, data);
    }
    return data;
  };
  api.get = (p, o) => api('GET', p, undefined, o);
  api.post = (p, b, o) => api('POST', p, b ?? {}, o);
  api.put = (p, b, o) => api('PUT', p, b ?? {}, o);
  api.del = (p, o) => api('DELETE', p, undefined, o);
  return api;
}

let ioLib = null;
export async function socket(auth) {
  if (!ioLib) ioLib = (await import('/socket.io/socket.io.esm.min.js')).io;
  return ioLib({ auth, transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 8000 });
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
