import { Toasts } from '../ui/basics';
import { useApp } from '../store';
import { Login, Setup } from './Login';
import { Shell } from './Shell';

export function App() {
  const phase = useApp((s) => s.phase);
  return (
    <>
      {phase === 'loading' || phase === 'connecting' ? (
        <div className="boot">
          <div className="boot-mark" />
          <div className="upper faint tiny">{phase === 'loading' ? 'Contacting server' : 'Synchronising'}</div>
        </div>
      ) : phase === 'setup' ? (
        <Setup />
      ) : phase === 'login' ? (
        <Login />
      ) : (
        <Shell />
      )}
      <Toasts />
    </>
  );
}
