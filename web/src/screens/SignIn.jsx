import { useState } from 'react';
import { motion } from 'motion/react';
import { KeyRound, Mail } from 'lucide-react';
import { emailSignInEnabled } from '@/lib/api';
import { useApp } from '@/lib/store';
import { ErrorBox } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

/** Two ways in: a staff email and password (Supabase Auth, when the build has the Supabase settings), or the panel password (owner). */
export function SignIn() {
  const { signIn, signInEmail, authTried, status } = useApp();
  const emailOn = emailSignInEnabled();
  const [mode, setMode] = useState(emailOn ? 'email' : 'password');
  const [secret, setSecret] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const busy = status === 'loading' || emailBusy;

  function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (mode === 'password') {
      const v = secret.trim();
      if (v) signIn(v);
      return;
    }
    if (!email.trim() || !password) return;
    setEmailError('');
    setEmailBusy(true);
    signInEmail(email, password).then(r => {
      setEmailBusy(false);
      if (r && !r.ok) setEmailError(r.error || 'Could not sign in.');
      else setPassword('');
    });
  }

  const emailMode = mode === 'email';
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <motion.form onSubmit={submit} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm rounded-2xl border border-border bg-card/80 p-6 shadow-2xl shadow-black/20 backdrop-blur-xl md:p-8">
        <div className="eyebrow">Sales tracker</div>
        <h1 className="page-title mt-3 text-6xl">Ledger</h1>
        {emailMode ? (
          <>
            <p className="mt-4 text-sm text-muted-foreground">Sign in with your staff email to open your dues, payments and reminders.</p>
            <div className="mt-8 grid gap-1.5">
              <Label htmlFor="staffEmail" className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Email</Label>
              <Input id="staffEmail" type="email" autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus
                className="h-11" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div className="mt-4 grid gap-1.5">
              <Label htmlFor="staffPassword" className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Password</Label>
              <Input id="staffPassword" type="password" autoComplete="current-password" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                className="h-11" value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            {emailError ? <div className="mt-3"><ErrorBox testId="signin-error">{emailError}</ErrorBox></div> : null}
          </>
        ) : (
          <>
            <p className="mt-4 text-sm text-muted-foreground">Enter the panel password to open your dues, payments and reminders.</p>
            <div className="mt-8 grid gap-1.5">
              <Label htmlFor="appSecret" className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Panel password</Label>
              <Input id="appSecret" type="password" autoComplete="current-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus
                className="h-11" value={secret} onChange={e => setSecret(e.target.value)} />
            </div>
            {authTried && !busy ? <div className="mt-3"><ErrorBox testId="signin-error">That password was not accepted.</ErrorBox></div> : null}
          </>
        )}
        <Button type="submit" size="lg" data-testid="signin" disabled={busy} className="mt-6 w-full font-extrabold">
          {busy ? <Spinner /> : emailMode ? <Mail /> : <KeyRound />}Sign in
        </Button>
        {emailOn ? (
          <button type="button" className="mt-4 w-full text-center text-xs font-semibold text-muted-foreground underline underline-offset-4"
            onClick={() => { setEmailError(''); setMode(emailMode ? 'password' : 'email'); }}>
            {emailMode ? 'Use the panel password instead' : 'Use my staff email instead'}
          </button>
        ) : null}
        <p className="mt-4 text-xs text-muted-foreground">Stored only in this browser. Sign out from More.</p>
      </motion.form>
    </div>
  );
}
