import type { DevDelivery } from '@owlwire/contracts';
import { useCallback, useEffect, useState } from 'react';
import { DevApiError, fetchDeliveries } from './api';

const TOKEN_KEY = 'owlwire.devToken';
const REFRESH_MS = 5000;

function readStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage can be unavailable (private mode); the token then lives only in memory.
  }
}

function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '-';
}

export function App() {
  const [token, setToken] = useState(readStoredToken);
  const [draft, setDraft] = useState(token);
  const [rows, setRows] = useState<DevDelivery[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const data = await fetchDeliveries(token);
      setRows(data.deliveries);
      setError(null);
      setLoadedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof DevApiError ? `${err.status}: ${err.message}` : String(err));
    }
  }, [token]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <main>
      <h1>Owlwire dev panel</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          storeToken(draft);
          setToken(draft);
        }}
      >
        <label htmlFor="token">Dev admin token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit">Save</button>
      </form>
      {!token && <p>Enter OWLWIRE_DEV_ADMIN_TOKEN to list deliveries.</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loadedAt && (
        <p className="muted">
          Last refresh {loadedAt}, {rows.length} deliveries
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Event</th>
            <th>Title</th>
            <th>Destination</th>
            <th>Platform</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>{formatTime(d.createdAt)}</td>
              <td>
                <code>{d.eventType}</code>
              </td>
              <td>{d.eventTitle ?? ''}</td>
              <td>{d.destinationName}</td>
              <td>{d.platform}</td>
              <td>
                <span className={`status status-${d.status}`}>{d.status}</span>
              </td>
              <td>{d.attempts}</td>
              <td>{d.lastError ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
