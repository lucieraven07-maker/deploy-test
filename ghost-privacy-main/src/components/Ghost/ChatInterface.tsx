import { useState, useEffect, useRef, useCallback, type ChangeEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ghost, Send, Paperclip, Shield, X, Loader2, Trash2, HardDrive, FileText, FileSpreadsheet, FileImage, FileArchive, FileCode, File, AlertTriangle, Clock, Download } from 'lucide-react';
import { toast } from 'sonner';
import { EncryptionEngine, KeyExchange, generateNonce } from '@/utils/encryption';
import { SecurityManager, validateMessage, validateFile, sanitizeFileName } from '@/utils/security';
import { RealtimeManager, BroadcastPayload, ConnectionState } from '@/lib/realtimeManager';
import { SessionService } from '@/lib/sessionService';
import { getMessageQueue, QueuedMessage } from '@/utils/clientMessageQueue';
import { cn } from '@/lib/utils';
import { generatePlausibleTimestamp, isTimestampObfuscationEnabled } from '@/utils/plausibleTimestamp';
import { useMemoryCleanup } from '@/hooks/useMemoryCleanup';
import KeyVerificationModal from './KeyVerificationModal';
import VoiceRecorder from './VoiceRecorder';
import VoiceMessage from './VoiceMessage';
import FilePreviewCard from './FilePreviewCard';
import TimestampSettings from './TimestampSettings';

interface ChatInterfaceProps {
  sessionId: string;
  isHost: boolean;
  timerMode: string;
  onEndSession: (showToast?: boolean) => void;
}

type TerminationReason = 'partner_left' | 'connection_lost' | 'channel_dead' | 'manual';

interface VerificationState {
  show: boolean;
  localFingerprint: string;
  remoteFingerprint: string;
  verified: boolean;
}

interface VoiceMessageData {
  id: string;
  blob: Blob;
  duration: number;
  sender: 'me' | 'partner';
  timestamp: number;
  played: boolean;
}

const ChatInterface = ({ sessionId, isHost, timerMode, onEndSession }: ChatInterfaceProps) => {
  const navigate = useNavigate();
  const { fullCleanup } = useMemoryCleanup();

  const [messages, setMessages] = useState<QueuedMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isPartnerConnected, setIsPartnerConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>({ status: 'connecting', progress: 0 });
  const [isKeyExchangeComplete, setIsKeyExchangeComplete] = useState(false);
  const [memoryStats, setMemoryStats] = useState({ messageCount: 0, estimatedBytes: 0 });
  const [verificationState, setVerificationState] = useState<VerificationState>({
    show: false,
    localFingerprint: '',
    remoteFingerprint: '',
    verified: false
  });
  const [voiceMessages, setVoiceMessages] = useState<VoiceMessageData[]>([]);
  const [voiceVerified, setVoiceVerified] = useState(false);
  const [isWindowVisible, setIsWindowVisible] = useState(true);
  const [showTimestampSettings, setShowTimestampSettings] = useState(false);
  const sessionKeyRef = useRef<CryptoKey | null>(null);

  const realtimeManagerRef = useRef<RealtimeManager | null>(null);
  const encryptionEngineRef = useRef<EncryptionEngine | null>(null);
  const keyPairRef = useRef<CryptoKeyPair | null>(null);
  const partnerPublicKeyRef = useRef<CryptoKey | null>(null);
  const participantIdRef = useRef<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageAreaRef = useRef<HTMLElement>(null);
  const inputBarRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageQueueRef = useRef(getMessageQueue());
  const partnerWasPresentRef = useRef(false);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const localFingerprintRef = useRef<string>('');
  const isTerminatingRef = useRef(false);
  const verificationShownRef = useRef(false);
  const systemMessagesShownRef = useRef<Set<string>>(new Set());
  const lastTerminationRef = useRef<number>(0);

  const syncMessagesFromQueue = useCallback(() => {
    const queuedMessages = messageQueueRef.current.getMessages(sessionId);
    setMessages([...queuedMessages]);
    setMemoryStats(messageQueueRef.current.getMemoryStats(sessionId));
  }, [sessionId]);

  useEffect(() => {
    initializeSession();

    return () => {
      cleanup();
    };
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const scrollToBottom = () => {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scrollToBottom);
    }

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', scrollToBottom);
      }
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsWindowVisible(!document.hidden);
    };

    const handleBlur = () => {
      setIsWindowVisible(false);
    };

    const handleFocus = () => {
      setIsWindowVisible(true);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'Leave Ghost session? Click "End Session" to properly terminate.';
      return e.returnValue;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [sessionId]);

  const initializeSession = async () => {
    try {
      setConnectionState({ status: 'validating', progress: 10 });

      participantIdRef.current = await SecurityManager.generateFingerprint();
      encryptionEngineRef.current = new EncryptionEngine();

      setConnectionState({ status: 'connecting', progress: 30 });

      keyPairRef.current = await KeyExchange.generateKeyPair();
      realtimeManagerRef.current = new RealtimeManager(sessionId, participantIdRef.current);

      setupMessageHandlers();

      setConnectionState({ status: 'subscribing', progress: 60 });

      await realtimeManagerRef.current.connect();
      await SessionService.extendSession(sessionId);

      addSystemMessage('🔐 Secure connection established');

    } catch {
      setConnectionState({ status: 'error', progress: 0, error: 'Connection failed' });
      toast.error('Failed to connect to session');
    }
  };

  const setupMessageHandlers = () => {
    const manager = realtimeManagerRef.current;
    if (!manager) return;

    manager.onStatusChange((newState) => {
      setConnectionState(newState);
      if (newState.status === 'connected') {
        sendPublicKey();
        setupHeartbeatMonitoring();
      }
    });

    manager.onPresenceChange(async (participants) => {
      const partnerCount = participants.filter(id => id !== participantIdRef.current).length;
      const hasPartner = partnerCount > 0;
      setIsPartnerConnected(hasPartner);

      // CRITICAL: If partner was connected and now left, terminate the session for remaining user
      if (partnerWasPresentRef.current && partnerCount === 0 && !isTerminatingRef.current) {
        partnerWasPresentRef.current = false;
        isTerminatingRef.current = true;
        addSystemMessage('⚠️ Partner disconnected - session ending...');
        // Small delay to let user see the message
        setTimeout(async () => {
          await triggerSessionTermination('partner_left');
          await cleanup();
          onEndSession(false); // Don't show toast - partner left message is enough
        }, 1500);
        return;
      }

      if (hasPartner) {
        partnerWasPresentRef.current = true;
        if (!isKeyExchangeComplete) {
          sendPublicKey();
        }
      }
    });

    manager.onMessage('key-exchange', async (payload) => {
      try {
        const partnerPublicKey = await KeyExchange.importPublicKey(payload.data.publicKey);
        partnerPublicKeyRef.current = partnerPublicKey;

        if (keyPairRef.current) {
          const sharedSecret = await KeyExchange.deriveSharedSecret(
            keyPairRef.current.privateKey,
            partnerPublicKey
          );

          sessionKeyRef.current = sharedSecret;
          await encryptionEngineRef.current?.setKey(sharedSecret);
          setIsKeyExchangeComplete(true);

          const remoteFingerprint = await KeyExchange.generateFingerprint(partnerPublicKey);

          // Only show verification modal ONCE per session
          if (!verificationShownRef.current) {
            verificationShownRef.current = true;
            setVerificationState(prev => ({
              ...prev,
              show: true,
              localFingerprint: localFingerprintRef.current,
              remoteFingerprint
            }));
          }

          addSystemMessage('🔐 Encryption established - verify security codes');
        }
      } catch {
        toast.error('Failed to establish secure connection');
      }
    });

    manager.onMessage('chat-message', async (payload) => {
      try {
        if (!encryptionEngineRef.current) return;

        const decrypted = await encryptionEngineRef.current.decryptMessage(
          payload.data.encrypted,
          payload.data.iv
        );

        messageQueueRef.current.addMessage(sessionId, {
          id: payload.nonce,
          content: decrypted,
          sender: 'partner',
          timestamp: payload.timestamp,
          type: payload.data.type || 'text',
          fileName: payload.data.fileName
        });

        syncMessagesFromQueue();
        await manager.send('message-ack', { messageId: payload.nonce });

      } catch {
        // Silent - message decryption failed
      }
    });

    manager.onMessage('voice-message', async (payload) => {
      try {
        if (!encryptionEngineRef.current) return;

        const decrypted = await encryptionEngineRef.current.decryptMessage(
          payload.data.encrypted,
          payload.data.iv
        );

        const binaryString = atob(decrypted);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'audio/webm;codecs=opus' });

        setVoiceMessages(prev => [...prev, {
          id: payload.nonce,
          blob,
          duration: payload.data.duration,
          sender: 'partner',
          timestamp: payload.timestamp,
          played: false
        }]);

        messageQueueRef.current.addMessage(sessionId, {
          id: payload.nonce,
          content: '[Voice Message]',
          sender: 'partner',
          timestamp: payload.timestamp,
          type: 'voice',
          fileName: undefined
        });
        syncMessagesFromQueue();
        await manager.send('message-ack', { messageId: payload.nonce });
      } catch {
        // Silent
      }
    });

    manager.onMessage('message-ack', (payload) => {
      messageQueueRef.current.acknowledgeMessage(sessionId, payload.data.messageId);
    });

    manager.onMessage('session-terminated', async () => {
      isTerminatingRef.current = true;
      await triggerSessionTermination('partner_left');
      await cleanup();
    });
  };

  const setupHeartbeatMonitoring = () => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }

    heartbeatIntervalRef.current = setInterval(() => {
      if (!realtimeManagerRef.current) return;

      const channel = (realtimeManagerRef.current as any).channel;
      if (channel && channel.state !== 'joined') {
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
      }
    }, 10000);
  };

  const sendPublicKey = async () => {
    if (!realtimeManagerRef.current || !keyPairRef.current) return;

    localFingerprintRef.current = await KeyExchange.generateFingerprint(keyPairRef.current.publicKey);
    const publicKeyExport = await KeyExchange.exportPublicKey(keyPairRef.current.publicKey);
    await realtimeManagerRef.current.send('key-exchange', { publicKey: publicKeyExport });
  };

  const handleVerificationConfirmed = () => {
    setVerificationState(prev => ({ ...prev, show: false, verified: true }));
    setVoiceVerified(true);
    addSystemMessage('✅ Security verified - all features enabled');
    toast.success('Connection verified as secure');
  };

  const handleVerificationCancelled = () => {
    setVerificationState(prev => ({ ...prev, show: false, verified: false }));
    setVoiceVerified(false);
    addSystemMessage('⚠️ Security verification failed - voice disabled');
    toast.error('Security codes did not match');
  };

  const handleRequestVoiceVerification = () => {
    if (verificationState.verified) {
      setVoiceVerified(true);
      toast.success('Voice messaging enabled');
    } else if (!verificationShownRef.current || !verificationState.show) {
      setVerificationState(prev => ({ ...prev, show: true }));
    }
  };

  const sendVoiceMessage = async (blob: Blob, duration: number) => {
    if (!encryptionEngineRef.current || !isKeyExchangeComplete) {
      toast.error('Secure connection not established');
      return;
    }

    if (!voiceVerified) {
      toast.error('Please verify security codes first');
      return;
    }

    try {
      const messageId = generateNonce();

      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      const { encrypted, iv } = await encryptionEngineRef.current.encryptMessage(base64);

      setVoiceMessages(prev => [...prev, {
        id: messageId,
        blob,
        duration,
        sender: 'me',
        timestamp: Date.now(),
        played: false
      }]);

      messageQueueRef.current.addMessage(sessionId, {
        id: messageId,
        content: '[Voice Message]',
        sender: 'me',
        timestamp: Date.now(),
        type: 'voice'
      });
      syncMessagesFromQueue();

      const sent = await realtimeManagerRef.current?.send('voice-message', {
        encrypted,
        iv,
        duration,
        messageId
      });

      if (!sent) {
        toast.error('Voice message may not have been delivered');
      }
    } catch {
      toast.error('Failed to send voice message');
    }
  };

  const handleVoiceMessagePlayed = (messageId: string) => {
    setVoiceMessages(prev =>
      prev.map(vm => vm.id === messageId ? { ...vm, played: true } : vm)
    );
  };

  const addSystemMessage = (content: string, unique = true) => {
    // Prevent duplicate system messages
    if (unique && systemMessagesShownRef.current.has(content)) {
      return;
    }
    if (unique) {
      systemMessagesShownRef.current.add(content);
    }

    const systemMessage: QueuedMessage = {
      id: generateNonce(),
      content,
      sender: 'me',
      timestamp: Date.now(),
      type: 'system',
      receivedAt: Date.now(),
      acknowledged: true
    };

    messageQueueRef.current.addMessage(sessionId, systemMessage);
    syncMessagesFromQueue();
  };

  const sendMessage = async () => {
    const validation = validateMessage(inputText);
    if (!validation.valid) {
      toast.error(validation.error);
      return;
    }

    if (!encryptionEngineRef.current || !isKeyExchangeComplete) {
      toast.error('Secure connection not established yet');
      return;
    }

    if (!verificationState.verified) {
      toast.error('Please verify security codes before sending messages');
      if (!verificationState.show) {
        setVerificationState(prev => ({ ...prev, show: true }));
      }
      return;
    }

    try {
      const messageId = generateNonce();
      const { encrypted, iv } = await encryptionEngineRef.current.encryptMessage(inputText.trim());

      const { displayTimestamp } = generatePlausibleTimestamp();

      messageQueueRef.current.addMessage(sessionId, {
        id: messageId,
        content: inputText.trim(),
        sender: 'me',
        timestamp: displayTimestamp,
        type: 'text'
      });
      syncMessagesFromQueue();

      const sent = await realtimeManagerRef.current?.send('chat-message', {
        encrypted,
        iv,
        type: 'text',
        messageId
      });

      if (!sent) {
        toast.error('Message may not have been delivered');
      }

      setInputText('');
    } catch {
      toast.error('Failed to send message');
    }
  };

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    event.target.value = '';

    const validation = validateFile(file);
    if (!validation.valid) {
      toast.error(validation.error);
      return;
    }

    if (validation.warning) {
      toast.warning(validation.warning);
    }

    if (!encryptionEngineRef.current || !isKeyExchangeComplete) {
      toast.error('Secure connection not established yet');
      return;
    }

    if (!verificationState.verified) {
      toast.error('Please verify security codes before sending files');
      setVerificationState(prev => ({ ...prev, show: true }));
      return;
    }

    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const base64 = e.target?.result as string;
        const sanitizedName = sanitizeFileName(file.name);
        const messageId = generateNonce();

        const { displayTimestamp } = generatePlausibleTimestamp();

        const { encrypted, iv } = await encryptionEngineRef.current!.encryptMessage(base64);

        messageQueueRef.current.addMessage(sessionId, {
          id: messageId,
          content: base64,
          sender: 'me',
          timestamp: displayTimestamp,
          type: 'file',
          fileName: sanitizedName
        });
        syncMessagesFromQueue();

        const sent = await realtimeManagerRef.current?.send('chat-message', {
          encrypted,
          iv,
          type: 'file',
          fileName: sanitizedName,
          fileType: file.type,
          messageId
        });

        if (!sent) {
          toast.error('File may not have been delivered');
        }
      } catch {
        toast.error('Failed to send file');
      }
    };

    reader.onerror = () => {
      toast.error('Failed to read file');
    };

    reader.readAsDataURL(file);
  };

  const triggerSessionTermination = async (reason: TerminationReason) => {
    try {
      await realtimeManagerRef.current?.send('session-terminated', {
        reason,
        timestamp: Date.now(),
        terminatedBy: participantIdRef.current
      });
    } catch {
      // Ignore
    }

    try {
      await SessionService.deleteSession(sessionId);
    } catch {
      // Silent
    }

    destroyLocalSessionData();
  };

  const destroyLocalSessionData = () => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }

    if (encryptionEngineRef.current) {
      encryptionEngineRef.current = null;
    }
    keyPairRef.current = null;
    partnerPublicKeyRef.current = null;

    messageQueueRef.current.nuclearPurge();

    setMessages([]);
    setInputText('');
    setIsPartnerConnected(false);
    setIsKeyExchangeComplete(false);
    setMemoryStats({ messageCount: 0, estimatedBytes: 0 });

    try {
      localStorage.removeItem(`ghost_session_${sessionId}`);
      localStorage.removeItem(`ghost_keys_${sessionId}`);
    } catch {
      // Ignore
    }

    if (typeof (window as any).gc === 'function') {
      try {
        (window as any).gc();
      } catch {
        // Ignore
      }
    }
  };

  const cleanup = async () => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }

    await realtimeManagerRef.current?.disconnect();
    messageQueueRef.current.destroySession(sessionId);

    encryptionEngineRef.current = null;
    keyPairRef.current = null;
    partnerPublicKeyRef.current = null;
  };

  /**
   * CRITICAL: Terminate session - always clickable, debounced, instant
   * - Max 1 execution per 2 seconds (debounce)
   * - No confirmation modal (coercion-resistance)
   * - Atomic server-side deletion
   */
  const handleEndSession = async () => {
    // Debounce: prevent rapid clicks (max 1 per 2 seconds)
    const now = Date.now();
    if (now - lastTerminationRef.current < 2000) {
      return;
    }
    lastTerminationRef.current = now;

    // Mark as terminating immediately
    if (isTerminatingRef.current) {
      return;
    }
    isTerminatingRef.current = true;

    // 1. Server-side nuclear wipe (atomic)
    await SessionService.deleteSession(sessionId);

    // 2. Clear all in-memory state
    destroyLocalSessionData();

    // 3. Full memory cleanup (keys, trapState, buffers)
    await fullCleanup();

    // 4. Disconnect realtime
    await cleanup();

    // 5. Redirect with no trace (history.replace)
    navigate('/', { replace: true });
  };

  const handleNuclearPurge = () => {
    messageQueueRef.current.destroySession(sessionId);
    setMessages([]);
    setMemoryStats({ messageCount: 0, estimatedBytes: 0 });
    toast.success('All messages purged from memory');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    return (
  return (
      <>
        <KeyVerificationModal
          localFingerprint={verificationState.localFingerprint}
          remoteFingerprint={verificationState.remoteFingerprint}
          onVerified={handleVerificationConfirmed}
          onCancel={handleVerificationCancelled}
          isVisible={verificationState.show}
        />

        <div className="chat-container-mobile h-[100dvh] flex flex-col bg-black overflow-hidden font-mono">

          {/* HUD Overlay Grid */}
          <div className="absolute inset-0 z-0 pointer-events-none bg-[url('/grid.svg')] opacity-5" style={{ backgroundSize: '20px 20px' }} />
          <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-primary/30 z-50 pointer-events-none" />
          <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-primary/30 z-50 pointer-events-none" />
          <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-primary/30 z-50 pointer-events-none" />
          <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-primary/30 z-50 pointer-events-none" />

          {isPartnerConnected && verificationState.verified && (
            <div className="fixed top-0 left-0 right-0 z-[60] bg-green-500/10 border-b border-green-500/30 text-green-500 text-[10px] font-mono text-center tracking-widest py-1 animate-pulse md:hidden" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
              [ SECURE LINE ACTIVE ]
            </div>
          )}

          <header className={cn(
            "mobile-header fixed left-0 right-0 z-50 bg-black/90 backdrop-blur-md border-b border-primary/20 h-14 md:h-16 flex items-center",
            isPartnerConnected && verificationState.verified ? "top-[calc(24px+env(safe-area-inset-top,0px))] md:top-0" : "top-[env(safe-area-inset-top,0px))] md:top-0"
          )}>
            <div className="container mx-auto px-2 md:px-4 flex items-center justify-between w-full h-full">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 border border-primary/50 flex items-center justify-center bg-primary/10">
                  <Ghost className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-primary/60 tracking-widest">SESSION ID:</span>
                    <span className="text-xs text-primary font-bold">{sessionId}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className={cn("w-1.5 h-1.5 rounded-full", isKeyExchangeComplete ? "bg-green-500 shadow-glow-green" : "bg-yellow-500 animate-pulse")} />
                    <span className={isKeyExchangeComplete ? "text-green-500" : "text-yellow-500"}>
                      {isKeyExchangeComplete ? "ENCRYPTION: AES-256" : "HANDSHAKE..."}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="hidden md:flex flex-col items-end text-[10px] text-primary/40 leading-tight">
                  <span>MEM_USAGE: {formatBytes(memoryStats.estimatedBytes)}</span>
                  <span>BUFFER_COUNT: {memoryStats.messageCount}</span>
                </div>

                <div className="h-8 w-[1px] bg-primary/20 mx-2" />

                <button
                  onClick={handleNuclearPurge}
                  className="p-2 border border-yellow-500/30 text-yellow-500 hover:bg-yellow-500/10 transition-colors"
                  title="Purge messages"
                >
                  <Trash2 className="h-4 w-4" />
                </button>

                <button
                  onClick={handleEndSession}
                  className="p-2 border border-destructive/50 text-destructive bg-destructive/10 hover:bg-destructive/20 transition-colors"
                  title="Terminate Session"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          </header>

          <div className={cn(
            "flex-shrink-0",
            isPartnerConnected && verificationState.verified
              ? "h-[calc(56px+24px+env(safe-area-inset-top,0px))] md:h-16"
              : "h-[calc(56px+env(safe-area-inset-top,0px))] md:h-16"
          )} />

          {/* Connection Progress Bar */}
          {connectionState.status !== 'connected' && connectionState.progress > 0 && (
            <div className="fixed top-0 left-0 right-0 z-40 h-[2px] bg-primary/10">
              <div
                className="h-full bg-primary shadow-glow-lg transition-all duration-300"
                style={{ width: `${connectionState.progress}%` }}
              />
            </div>
          )}

          <main
            ref={messageAreaRef}
            className="mobile-message-area flex-1 overflow-y-auto overflow-x-hidden p-4 relative"
          >
            <div className="max-w-3xl mx-auto space-y-4">
              <div className="flex justify-center mb-6">
                <div className="tech-border text-[10px] text-primary/60 px-4 py-1 tracking-widest bg-black/50">
                // MEMORY_BUFFER_INIT //
                </div>
              </div>

              <div className={cn(
                "space-y-4 transition-all duration-200",
                !isWindowVisible && "message-blur"
              )}>
                {messages.map((message) => {
                  const voiceMessage = message.type === 'voice'
                    ? voiceMessages.find(vm => vm.id === message.id)
                    : null;

                  return (
                    <div
                      key={message.id}
                      className={cn(
                        "flex",
                        message.type === 'system' ? 'justify-center' : message.sender === 'me' ? 'justify-end' : 'justify-start'
                      )}
                    >
                      {message.type === 'system' ? (
                        <div className="px-4 py-1 text-[10px] text-primary/50 tracking-widest border-t border-b border-primary/10 bg-primary/5 w-full text-center">
                        >> SYSTEM: {message.content}
                        </div>
                      ) : message.type === 'voice' && voiceMessage ? (
                        <VoiceMessage
                          messageId={voiceMessage.id}
                          audioBlob={voiceMessage.blob}
                          duration={voiceMessage.duration}
                          sender={voiceMessage.sender}
                          timestamp={voiceMessage.timestamp}
                          onPlayed={handleVoiceMessagePlayed}
                        />
                      ) : (
                        <div
                          className={cn(
                            "max-w-[85%] relative group",
                            message.sender === 'me' ? "text-right" : "text-left"
                          )}
                        >
                          <div className={cn(
                            "text-[9px] text-primary/40 mb-1 tracking-widest",
                            message.sender === 'me' ? "pr-1" : "pl-1"
                          )}>
                            {message.sender === 'me' ? 'TX_OUT' : 'RX_IN'} // {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </div>

                          <div className={cn(
                            "p-3 border text-sm font-mono relative",
                            message.sender === 'me'
                              ? "bg-primary/10 border-primary/50 text-white rounded-tl-lg rounded-bl-lg rounded-br-lg"
                              : "bg-secondary/50 border-white/20 text-primary-foreground rounded-tr-lg rounded-br-lg rounded-bl-lg"
                          )}>
                            {/* Decorative corner accent */}
                            <div className={cn(
                              "absolute top-0 w-2 h-2 border-t border-primary/50",
                              message.sender === 'me' ? "right-0 border-r" : "left-0 border-l"
                            )} />

                            {message.type === 'file' ? (
                              message.content.startsWith('data:image') ? (
                                <div className="space-y-2">
                                  <div className="text-[10px] text-primary/60 uppercase tracking-widest border-b border-primary/20 pb-1 mb-2">
                                    [ IMAGE_DATA_RECEIVED ]
                                  </div>
                                  <img
                                    src={message.content}
                                    alt={message.fileName || 'Shared image'}
                                    className="max-w-full rounded border border-primary/20 opacity-90 hover:opacity-100 transition-opacity"
                                    loading="lazy"
                                  />
                                </div>
                              ) : (
                                <FilePreviewCard
                                  fileName={message.fileName || 'Unknown File'}
                                  content={message.content}
                                  sender={message.sender}
                                />
                              )
                            ) : (
                              <p className="whitespace-pre-wrap break-words">{message.content}</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div ref={messagesEndRef} className="h-4" />
            </div>
          </main>

          <footer
            ref={inputBarRef}
            className="mobile-input-bar bg-black/90 border-t border-primary/30"
          >
            <div className="container mx-auto max-w-3xl">
              <div className="flex items-center gap-2 mb-2">
                <div className="flex-1 bg-black/50 border border-primary/30 flex items-center p-2 relative">
                  <div className="absolute top-0 left-0 w-1 h-2 bg-primary/50" />
                  <div className="absolute top-0 right-0 w-1 h-2 bg-primary/50" />
                  <div className="absolute bottom-0 left-0 w-1 h-2 bg-primary/50" />
                  <div className="absolute bottom-0 right-0 w-1 h-2 bg-primary/50" />

                  <span className="text-primary/50 mr-2 animate-pulse">{'>'}</span>

                  <textarea
                    value={inputText}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      const textarea = e.target;
                      textarea.style.height = 'auto';
                      const newHeight = Math.min(textarea.scrollHeight, 100);
                      textarea.style.height = `${newHeight}px`;
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={isKeyExchangeComplete ? "ENTER COMMAND / MESSAGE..." : "AWAITING KEY EXCHANGE..."}
                    disabled={!isKeyExchangeComplete}
                    rows={1}
                    className="flex-1 bg-transparent border-none focus:ring-0 text-primary placeholder:text-primary/20 text-sm font-mono resize-none"
                    style={{ minHeight: '24px' }}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="true"
                  />
                </div>

                <button
                  onClick={sendMessage}
                  disabled={!inputText.trim() || !isKeyExchangeComplete}
                  className="bg-primary/10 border border-primary text-primary hover:bg-primary/20 disabled:opacity-30 disabled:cursor-not-allowed p-3 transition-all"
                  aria-label="Send message"
                >
                  <div className="flex flex-col items-center justify-center">
                    <span className="text-[8px] tracking-widest mb-0.5">SEND</span>
                    <ArrowRight className="h-4 w-4" />
                  </div>
                </button>
              </div>

              <div className="flex items-center gap-4 px-1">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!isKeyExchangeComplete}
                  className="text-primary/50 hover:text-primary transition-colors text-[10px] tracking-widest flex items-center gap-1 uppercase"
                >
                  <Paperclip className="h-3 w-3" />
                  ATTACH_DATA
                </button>

                <button
                  onClick={() => setShowTimestampSettings(true)}
                  className="text-primary/50 hover:text-primary transition-colors text-[10px] tracking-widest flex items-center gap-1 uppercase"
                >
                  <Clock className="h-3 w-3" />
                  TIME_OBF
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileUpload}
                />

                <div className="ml-auto">
                  <VoiceRecorder
                    sessionKey={sessionKeyRef.current}
                    onVoiceMessage={sendVoiceMessage}
                    disabled={!isKeyExchangeComplete || !verificationState.verified}
                    voiceVerified={voiceVerified}
                    onRequestVerification={handleRequestVoiceVerification}
                  />
                </div>
              </div>
            </div>
          </footer>
        </div>
        <TimestampSettings
          open={showTimestampSettings}
          onClose={() => setShowTimestampSettings(false)}
        />
      </>
    );
  };

  // Connection Status Component
  const ConnectionStatusIndicator = ({ state, isPartnerConnected }: { state: ConnectionState; isPartnerConnected: boolean }) => {
    const getStatusInfo = () => {
      if (state.status === 'connected' && isPartnerConnected) {
        return { text: 'Partner Connected', color: 'text-accent', dot: 'bg-accent' };
      }
      if (state.status === 'connected') {
        return { text: 'Waiting for Partner', color: 'text-yellow-500', dot: 'bg-yellow-500' };
      }
      if (state.status === 'error') {
        return { text: state.error || 'Connection Error', color: 'text-destructive', dot: 'bg-destructive' };
      }
      return { text: 'Connecting...', color: 'text-muted-foreground', dot: 'bg-muted-foreground' };
    };

    const { text, color, dot } = getStatusInfo();

    return (
      <div className={cn("flex items-center gap-2 text-xs", color)}>
        <div className={cn("w-2 h-2 rounded-full animate-pulse", dot)} />
        <span>{text}</span>
      </div>
    );
  };

  export default ChatInterface;
