'use client';
import { useState } from 'react';
import {
  ArrowRight,
  Building2,
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { post } from '@/lib/client';
export default function Login({
  onLogin,
  initialError,
}: {
  onLogin: () => void;
  initialError: string;
}) {
  const [username, setUsername] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('auth/login', { username, password });
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-screen">
      <section className="login-visual">
        <img
          src="/images/samana-ocean-bay-sunset.jpg"
          alt="Sunset over the pool at SAMANA Ocean Bay"
        />
        <div className="login-shade" />
        <a className="brand" href="/">
          SAMANA<span>DEVELOPERS</span>
        </a>
        <div className="login-copy">
          <p className="eyebrow">WHERE DREAMS TAKE SHAPE</p>
          <h1>
            Extraordinary places.
            <br />
            <em>Exceptional care.</em>
          </h1>
          <p>One connected workspace for every customer journey.</p>
          <div>
            <span>CRM</span>
            <i />
            <span>Collection</span>
            <i />
            <span>Customer Experience</span>
          </div>
        </div>
        <small>
          SAMANA OCEAN BAY · DUBAI ISLANDS <span>01 / CUSTOMER EXPERIENCE</span>
        </small>
      </section>
      <section className="login-form-panel">
        <div className="login-form-content">
          <span className="workspace-pill">
            <Building2 size={15} /> THE SAMANA WORKSPACE
          </span>
          <h2>
            Welcome back<span>.</span>
          </h2>
          <p>
            Great experiences start with you.
            <br />
            Sign in to your customer experience workspace.
          </p>
          <form onSubmit={submit}>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="username">Username / email</label>
              <Input
                className="form-control"
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                placeholder="Your work account"
              />
            </div>
            <div>
              <label htmlFor="password">Password</label>
              <div className="password-field">
                <Input
                  className="form-control"
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  onKeyUp={(event) =>
                    setCapsLock(event.getModifierState('CapsLock'))
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>
              {capsLock && (
                <output className="caps-lock">Caps Lock is on</output>
              )}
            </div>
            <Button type="submit" className="primary-action" disabled={busy}>
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <>
                  Enter workspace
                  <ArrowRight size={17} />
                </>
              )}
            </Button>
          </form>
          <div className="login-help">
            <ShieldCheck size={17} />
            <p>
              Access is managed by your QMS administrator.
              <br />
              Contact them if you need an account or password reset.
            </p>
          </div>
        </div>
        <footer>
          Samana Developers <span>Dubai, United Arab Emirates</span>
        </footer>
      </section>
    </main>
  );
}
