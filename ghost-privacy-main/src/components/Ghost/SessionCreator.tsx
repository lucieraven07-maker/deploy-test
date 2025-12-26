import { useState, useRef } from 'react';
import { Ghost, Copy, Check, ArrowRight, Loader2, Shield, Lock, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { generateGhostId, isValidGhostId } from '@/utils/encryption';
import { SecurityManager } from '@/utils/security';
import { SessionService } from '@/lib/sessionService';
import { HoneypotService } from '@/lib/honeypotService';
import { cn } from '@/lib/utils';
import FalconEye from './FalconEye';

interface SessionCreatorProps {
  onSessionStart: (sessionId: string, isHost: boolean, timerMode: string) => void;
  onHoneypotDetected?: (sessionId: string, trapType: string) => void;
}

const SessionCreator = ({ onSessionStart, onHoneypotDetected }: SessionCreatorProps) => {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [ghostId, setGhostId] = useState('');
  const [joinId, setJoinId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against double-execution
  const isCreatingRef = useRef(false);

  const handleCreateSession = async () => {
    // Prevent double execution
    if (isCreatingRef.current || isLoading) return;
    isCreatingRef.current = true;

    setIsLoading(true);
    setError(null);

    try {
      const newId = generateGhostId();
      const fingerprint = await SecurityManager.generateFingerprint();

      const result = await SessionService.reserveSession(newId, fingerprint);

      if (!result.success) {
        // Distinguish error types for user
        if (result.errorType === 'NETWORK_ERROR') {
          setError('Network unreachable. Check your connection.');
        } else if (result.errorType === 'RATE_LIMITED') {
          setError('Too many attempts. Please wait a moment.');
        } else {
          setError(result.error || 'Failed to create session');
        }
        return;
      }

      setGhostId(newId);
      setIsWaiting(true);
      toast.success('Secure channel established');
    } catch {
      setError('Failed to create session. Please retry.');
    } finally {
      setIsLoading(false);
      isCreatingRef.current = false;
    }
  };

  const handleCopyId = async () => {
    await navigator.clipboard.writeText(ghostId);
    setIsCopied(true);
    toast.success('Access code copied');
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleStartSession = () => {
    if (ghostId) {
      onSessionStart(ghostId, true, 'on-leave');
    }
  };

  const handleJoinSession = async () => {
    if (isLoading) return;

    const trimmedId = joinId.trim().toUpperCase();

    // Allow both standard format and honeypot formats
    const isStandardFormat = isValidGhostId(trimmedId);
    const isHoneypotFormat = HoneypotService.hasHoneypotPrefix(trimmedId);

    if (!isStandardFormat && !isHoneypotFormat) {
      setError('Invalid access code format');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Generate fingerprint for honeypot tracking
      const fingerprint = await SecurityManager.generateFingerprint();

      // Check if this is a honeypot FIRST (before validation)
      const honeypotCheck = await HoneypotService.checkSession(trimmedId, fingerprint);

      if (honeypotCheck.isHoneypot) {
        // Route to honeypot interface - attacker doesn't know
        if (onHoneypotDetected) {
          onHoneypotDetected(trimmedId, honeypotCheck.trapType || 'unknown');
        }
        return;
      }

      // Normal session validation
      const isValid = await SessionService.validateSession(trimmedId);
      if (!isValid) {
        setError('Channel not found or access revoked');
        return;
      }

      onSessionStart(trimmedId, false, 'on-leave');
    } catch {
      setError('Network error. Check your connection.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen min-h-[100dvh] pt-20 pb-8 md:pt-24 md:pb-12 flex items-center justify-center px-4 safe-area-inset-top relative overflow-hidden bg-black">
      {/* 3D Falcon Eye Background */}
      <FalconEye className="absolute inset-0 z-0 opacity-80" />

      {/* HUD Grid Overlay */}
      <div className="absolute inset-0 z-0 pointer-events-none bg-[url('/grid.svg')] opacity-10" style={{ backgroundSize: '40px 40px' }} />
      <div className="absolute inset-0 z-0 pointer-events-none bg-gradient-to-b from-transparent via-transparent to-black/90" />

      <div className="w-full max-w-xl mx-auto relative z-10 animate-fade-in-up">
        {/* Cinematic Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 px-4 py-2 mb-6 border border-primary/30 bg-primary/5 rounded-none tech-border">
            <Lock className="h-4 w-4 text-primary animate-pulse" />
            <span className="text-xs font-mono text-primary tracking-[0.2em] uppercase">Secure Terminal // v3.0</span>
          </div>

          <h1 className="font-outfit font-black text-4xl md:text-5xl lg:text-6xl text-transparent bg-clip-text bg-gradient-to-r from-white to-white/50 mb-4 tracking-tighter">
            GHOST
          </h1>
          <p className="font-mono text-primary/70 text-xs md:text-sm tracking-widest uppercase">
            Military-Grade Ephemeral Communication
          </p>
        </div>

        {/* Mode Toggle */}
        <div className="flex p-1 mb-8 gap-2">
          <button
            onClick={() => { setMode('create'); setIsWaiting(false); setGhostId(''); }}
            className={cn(
              "flex-1 py-3 px-4 text-sm font-mono tracking-wider transition-all duration-300 border",
              mode === 'create'
                ? "bg-primary/10 border-primary text-primary shadow-[0_0_15px_hsl(var(--primary)/0.3)]"
                : "bg-transparent border-transparent text-muted-foreground hover:text-white hover:border-white/20"
            )}
            style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}
          >
            INITIALIZE
          </button>
          <button
            onClick={() => { setMode('join'); setIsWaiting(false); setGhostId(''); }}
            className={cn(
              "flex-1 py-3 px-4 text-sm font-mono tracking-wider transition-all duration-300 border",
              mode === 'join'
                ? "bg-primary/10 border-primary text-primary shadow-[0_0_15px_hsl(var(--primary)/0.3)]"
                : "bg-transparent border-transparent text-muted-foreground hover:text-white hover:border-white/20"
            )}
            style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}
          >
            CONNECT
          </button>
        </div>

        {/* Main Terminal Card */}
        <div className="p-1 rounded-none bg-gradient-to-b from-primary/20 to-transparent">
          <div className="p-8 bg-black/80 backdrop-blur-xl border border-primary/20 tech-border relative overflow-hidden">
            {/* Corner Markers */}
            <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-primary" />
            <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-primary" />
            <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-primary" />
            <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-primary" />

            {/* Scanline overlay */}
            <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] z-0 bg-[length:100%_4px,3px_100%] opacity-20" />

            <div className="relative z-10">
              {mode === 'create' ? (
                <>
                  {!isWaiting ? (
                    <div className="space-y-6">
                      <div className="flex items-center justify-center">
                        <div className="w-16 h-16 rounded-full border border-primary/30 flex items-center justify-center animate-pulse-ring">
                          <Shield className="h-8 w-8 text-primary" />
                        </div>
                      </div>

                      <div className="text-center space-y-2">
                        <h3 className="font-mono text-lg text-white">GENERATE SECURE KEY</h3>
                        <p className="text-muted-foreground text-xs font-mono">
                          INITIATING ONE-TIME PAD PROTOCOL...
                        </p>
                      </div>

                      {error && (
                        <div className="p-3 bg-destructive/10 border border-destructive/30 text-destructive text-xs font-mono flex items-center gap-2">
                          <AlertCircle className="h-3 w-3" />
                          {error}
                        </div>
                      )}

                      <button
                        onClick={handleCreateSession}
                        disabled={isLoading}
                        className="cyber-button w-full flex items-center justify-center gap-2 group"
                      >
                        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ghost className="h-4 w-4" />}
                        <span className="tracking-[0.2em]">{isLoading ? 'INITIALIZING...' : 'EXECUTE'}</span>
                        <ArrowRight className="h-4 w-4 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      <div className="text-center space-y-4">
                        <div className="inline-block px-3 py-1 bg-green-500/10 border border-green-500/30 text-green-500 text-xs font-mono tracking-widest animate-pulse">
                          CHANNEL STATUS: ACTIVE
                        </div>

                        <div className="relative group">
                          <div className="absolute inset-0 bg-primary/20 blur-xl group-hover:bg-primary/30 transition-all opacity-50" />
                          <div className="relative border-2 border-dashed border-primary/30 bg-black/50 p-6 font-mono text-2xl md:text-3xl text-primary text-center tracking-[0.2em] select-all">
                            {ghostId}
                          </div>
                          <button
                            onClick={handleCopyId}
                            className="absolute top-2 right-2 p-2 text-primary/50 hover:text-primary transition-colors"
                          >
                            {isCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </button>
                        </div>

                        <p className="text-xs text-muted-foreground font-mono animate-pulse">
                          WAITING FOR PEER CONNECTION...
                        </p>
                      </div>

                      <button
                        onClick={handleStartSession}
                        className="cyber-button w-full"
                      >
                        ENTER CHANNEL
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-6">
                  <div className="text-center space-y-2">
                    <h3 className="font-mono text-lg text-white">ACCESS SECURE CHANNEL</h3>
                    <p className="text-muted-foreground text-xs font-mono">
                      ENTER AUTHORIZATION CODE
                    </p>
                  </div>

                  {error && (
                    <div className="p-3 bg-destructive/10 border border-destructive/30 text-destructive text-xs font-mono flex items-center gap-2">
                      <AlertCircle className="h-3 w-3" />
                      {error}
                    </div>
                  )}

                  <input
                    type="text"
                    value={joinId}
                    onChange={(e) => { setJoinId(e.target.value.toUpperCase()); setError(null); }}
                    placeholder="GHOST-XXXX-XXXX"
                    className="w-full bg-black/50 border border-primary/30 p-4 text-center font-mono text-xl text-primary placeholder:text-primary/20 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-all"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                  />

                  <button
                    onClick={handleJoinSession}
                    disabled={isLoading || !joinId.trim()}
                    className="cyber-button w-full flex items-center justify-center gap-2"
                  >
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                    <span className="tracking-[0.2em]">CONNECT</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Security Footer */}
        <div className="mt-8 flex justify-between items-end px-4 font-mono text-[10px] text-primary/40 uppercase">
          <div>
            <p>RAM: SECURE</p>
            <p>DISK: NULL</p>
            <p>NET: ENCRYPTED</p>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2 justify-end">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              SYSTEM ONLINE
            </div>
            <p>V 3.0.1 BUILD 2025</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SessionCreator;
