import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  FlatList,
  ScrollView,
  Alert,
  Share,
  ActivityIndicator,
  useColorScheme,
  StatusBar as RNStatusBar,
  Modal,
  Linking,
  AppState,
  Switch,
  Image,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { File, Paths } from 'expo-file-system';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import {
  loadModel,
  start,
  stop,
  onResult,
  onPartialResult,
  onFinalResult,
  onError,
} from 'react-native-vosk';
import TranslateText, {
  TranslateLanguage,
} from '@react-native-ml-kit/translate-text';

interface TranscriptItem {
  id: string;
  time: string;
  text: string;
  translation?: string;
  isTranslating?: boolean;
}

interface TranscriptionSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: TranscriptItem[];
}

type ModelStatus = 'initializing' | 'ready' | 'recording' | 'error';
type LanguageMode = 'bilingual' | 'cy' | 'en';

// Device storage persistent files
const sessionsStorageFile = new File(Paths.document, 'saved_sessions.json');
const legacyTranscriptsFile = new File(Paths.document, 'saved_transcripts.json');
const settingsStorageFile = new File(Paths.document, 'app_settings.json');

// In-memory cache and write timers for serialization & debouncing (Fix #5)
let inMemorySettings: Record<string, any> = {};
let settingsWriteTimer: any = null;
let sessionsWriteTimer: any = null;

// Format YYYY-MM-DD HH:mm for session timestamps
function formatSessionDate(date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

// Derive readable session title from first utterance
function deriveSessionTitle(items: TranscriptItem[], fallbackDate: string): string {
  if (items.length > 0 && items[0].text.trim()) {
    const first = items[0].text.trim();
    return first.length > 44 ? first.slice(0, 44) + '…' : first;
  }
  return fallbackDate;
}

// Save discrete sessions to device storage (debounced)
function saveSessionsToStorage(sessionsList: TranscriptionSession[], immediate = false) {
  if (sessionsWriteTimer) clearTimeout(sessionsWriteTimer);
  const doWrite = async () => {
    try {
      await sessionsStorageFile.write(JSON.stringify(sessionsList));
    } catch (err) {
      console.warn('Failed to save sessions to storage:', err);
    }
  };
  if (immediate) {
    doWrite();
  } else {
    sessionsWriteTimer = setTimeout(doWrite, 250);
  }
}

// Load discrete sessions from device storage with stuck-spinner sanitization & legacy migration
async function loadSessionsFromStorage(): Promise<TranscriptionSession[]> {
  try {
    if (sessionsStorageFile.exists) {
      const data = await sessionsStorageFile.text();
      if (data && data.trim()) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((s) => s && Array.isArray(s.items) && s.items.length > 0)
            .map((s) => ({
              ...s,
              items: s.items.map((item: TranscriptItem) => ({
                ...item,
                isTranslating: false,
              })),
            }));
        }
      }
    } else if (legacyTranscriptsFile.exists) {
      // Migrate legacy flat saved_transcripts.json into a discrete session
      const legacyData = await legacyTranscriptsFile.text();
      if (legacyData && legacyData.trim()) {
        const parsedLegacy = JSON.parse(legacyData);
        if (Array.isArray(parsedLegacy) && parsedLegacy.length > 0) {
          const sanitizedItems: TranscriptItem[] = parsedLegacy.map((item) => ({
            ...item,
            isTranslating: false,
          }));
          const created = formatSessionDate();
          const migratedSession: TranscriptionSession = {
            id: 'sess_' + Date.now().toString(),
            title: deriveSessionTitle(sanitizedItems, created),
            createdAt: created,
            updatedAt: sanitizedItems[sanitizedItems.length - 1]?.time || created,
            items: sanitizedItems,
          };
          await sessionsStorageFile.write(JSON.stringify([migratedSession]));
          await legacyTranscriptsFile.write('[]');
          return [migratedSession];
        }
      }
    }
  } catch (err) {
    console.warn('Failed to load sessions from storage:', err);
  }
  return [];
}

// Save application settings to device storage (debounced & cached, Fix #5)
function saveSettingsToStorage(settings: Record<string, any>) {
  inMemorySettings = { ...inMemorySettings, ...settings };
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer);
  settingsWriteTimer = setTimeout(async () => {
    try {
      await settingsStorageFile.write(JSON.stringify(inMemorySettings));
    } catch (err) {
      console.warn('Failed to save settings:', err);
    }
  }, 200);
}

// Load application settings from device storage
async function loadSettingsFromStorage(): Promise<Record<string, any> | null> {
  try {
    if (settingsStorageFile.exists) {
      const txt = await settingsStorageFile.text();
      if (txt && txt.trim()) {
        inMemorySettings = JSON.parse(txt);
        return inMemorySettings;
      }
    }
  } catch (err) {
    console.warn('Failed to load settings:', err);
  }
  return null;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MainApp />
    </SafeAreaProvider>
  );
}

function MainApp() {
  const insets = useSafeAreaInsets();
  const systemScheme = useColorScheme();
  const [isDarkMode, setIsDarkMode] = useState<boolean>(systemScheme === 'dark');
  const [modelStatus, setModelStatus] = useState<ModelStatus>('initializing');
  const [customError, setCustomError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [partialText, setPartialText] = useState<string>('');
  const [partialTranslation, setPartialTranslation] = useState<string>('');
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [sessions, setSessions] = useState<TranscriptionSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showSessionsDropdown, setShowSessionsDropdown] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<number>(16);
  const [langMode, setLangMode] = useState<LanguageMode>('bilingual');
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [translateEnabled, setTranslateEnabled] = useState<boolean>(true);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState<boolean>(true);
  const [isStorageLoaded, setIsStorageLoaded] = useState<boolean>(false);
  const [showAboutModal, setShowAboutModal] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showTimestamps, setShowTimestamps] = useState<boolean>(true);

  const flatListRef = useRef<FlatList<TranscriptItem>>(null);
  const isNearBottomRef = useRef<boolean>(true);
  const currentSessionIdRef = useRef<string | null>(null);
  const translateEnabledRef = useRef<boolean>(true);
  const partialTranslateTimerRef = useRef<any>(null);
  const partialRequestIdRef = useRef<number>(0);
  const partialTranslationRef = useRef<string>('');
  const feedbackTimerRef = useRef<any>(null);
  const isRecordingRef = useRef<boolean>(false);
  const handleNewUtteranceRef = useRef<(rawText: string) => void>(() => {});
  const handleLivePartialTranslationRef = useRef<(text: string) => void>(() => {});

  useEffect(() => {
    translateEnabledRef.current = translateEnabled;
  }, [translateEnabled]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Color Theme definitions
  const theme = isDarkMode
    ? {
        bg: '#0F172A',
        cardBg: '#1E293B',
        cardBorder: '#334155',
        headerText: '#F8FAFC',
        subText: '#94A3B8',
        liveBoxBg: '#2A1418',
        liveText: '#F8FAFC',
        liveBorder: '#7F1D1D',
        liveTranslationBg: '#14291F',
        liveTranslationText: '#34D399',
        transcriptBoxBg: '#1E293B',
        transcriptText: '#F1F5F9',
        translationCardBg: '#064E3B',
        translationBorder: '#10B981',
        translationText: '#A7F3D0',
        timeBadgeBg: '#334155',
        timeBadgeText: '#CBD5E1',
        toolbarBg: '#1E293B',
        toolbarBorder: '#334155',
        toggleInactiveBg: '#334155',
        toggleInactiveText: '#94A3B8',
        statusBg: '#1E293B',
        statusBorder: '#334155',
        statusText: '#CBD5E1',
        btnSecondaryBg: '#334155',
        btnSecondaryText: '#34D399',
        iconHeader: '#94A3B8',
      }
    : {
        bg: '#F8FAFC',
        cardBg: '#FFFFFF',
        cardBorder: '#E2E8F0',
        headerText: '#0F172A',
        subText: '#64748B',
        liveBoxBg: '#FFF5F5',
        liveText: '#0F172A',
        liveBorder: '#FED7D7',
        liveTranslationBg: '#E6F4EA',
        liveTranslationText: '#065F46',
        transcriptBoxBg: '#FFFFFF',
        transcriptText: '#0F172A',
        translationCardBg: '#ECFDF5',
        translationBorder: '#059669',
        translationText: '#065F46',
        timeBadgeBg: '#F1F5F9',
        timeBadgeText: '#64748B',
        toolbarBg: '#FAFAFA',
        toolbarBorder: '#EDF2F7',
        toggleInactiveBg: '#E2E8F0',
        toggleInactiveText: '#475569',
        statusBg: '#FFFFFF',
        statusBorder: '#E2E8F0',
        statusText: '#334155',
        btnSecondaryBg: '#F1F5F9',
        btnSecondaryText: '#00843D',
        iconHeader: '#475569',
      };

  // Helper to format timestamps HH:mm:ss
  const getTimestamp = () => {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  };

  // Helper for UI text based on language mode
  const t = (cy: string, en: string) => {
    if (langMode === 'cy') return cy;
    if (langMode === 'en') return en;
    return `${cy} / ${en}`;
  };

  // Dynamically computed status text (Fix #1: no model reload on language toggle)
  const getStatusText = () => {
    if (customError) {
      return (langMode === 'cy' ? 'Gwall: ' : langMode === 'en' ? 'Error: ' : 'Gwall / Error: ') + customError;
    }
    switch (modelStatus) {
      case 'initializing':
        return t('Yn llwytho model Cymraeg...', 'Loading Welsh speech model...');
      case 'ready':
        return t('Barod i recordio', 'Ready to record');
      case 'recording':
        return t('Yn recordio... Siaradwch yn Gymraeg', 'Recording... Speak in Welsh');
      case 'error':
        return t('Gwall wrth lwytho model', 'Error loading model');
      default:
        return '';
    }
  };

  // Temporary feedback toast (Fix #10: clear previous timeout)
  const showFeedback = (msg: string) => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setFeedbackMessage(msg);
    feedbackTimerRef.current = setTimeout(() => {
      setFeedbackMessage(null);
    }, 2500);
  };

  // Keep awake and AppState background handler (Fix #11)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'background' && isRecordingRef.current) {
        handleStop();
      }
    });
    return () => {
      sub.remove();
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
      }
      deactivateKeepAwake();
      try {
        stop();
      } catch {}
    };
  }, []);

  // Load saved sessions & settings on launch (starts in a clean live session)
  useEffect(() => {
    let isMounted = true;
    async function initStorage() {
      try {
        const savedSettings = await loadSettingsFromStorage();
        let shouldAutoSave = true;

        if (isMounted && savedSettings) {
          if (typeof savedSettings.autoSaveEnabled === 'boolean') {
            shouldAutoSave = savedSettings.autoSaveEnabled;
            setAutoSaveEnabled(savedSettings.autoSaveEnabled);
          }
          if (typeof savedSettings.isDarkMode === 'boolean') {
            setIsDarkMode(savedSettings.isDarkMode);
          }
          if (typeof savedSettings.fontSize === 'number') {
            setFontSize(savedSettings.fontSize);
          }
          if (typeof savedSettings.translateEnabled === 'boolean') {
            setTranslateEnabled(savedSettings.translateEnabled);
            translateEnabledRef.current = savedSettings.translateEnabled;
          }
          if (typeof savedSettings.showTimestamps === 'boolean') {
            setShowTimestamps(savedSettings.showTimestamps);
          }
          if (
            savedSettings.langMode === 'bilingual' ||
            savedSettings.langMode === 'cy' ||
            savedSettings.langMode === 'en'
          ) {
            setLangMode(savedSettings.langMode);
          }
        }

        if (shouldAutoSave) {
          const savedSessions = await loadSessionsFromStorage();
          if (isMounted && savedSessions.length > 0) {
            setSessions(savedSessions);
          }
        }
        if (isMounted) {
          setIsStorageLoaded(true);
        }
      } catch (err) {
        console.warn('Storage initialization error:', err);
        if (isMounted) setIsStorageLoaded(true);
      }
    }

    initStorage();
    return () => {
      isMounted = false;
    };
  }, []);

  // Auto-save active session into discrete sessions list whenever transcripts change
  useEffect(() => {
    if (!isStorageLoaded || !autoSaveEnabled || transcripts.length === 0) return;

    let sessId = currentSessionIdRef.current;
    if (!sessId) {
      sessId = 'sess_' + Date.now().toString() + Math.random().toString(36).slice(2, 6);
      currentSessionIdRef.current = sessId;
      setCurrentSessionId(sessId);
    }

    const nowDate = formatSessionDate();
    const updatedTime = transcripts[transcripts.length - 1]?.time || nowDate;

    setSessions((prev) => {
      const existingIdx = prev.findIndex((s) => s.id === sessId);
      let next: TranscriptionSession[];
      if (existingIdx >= 0) {
        const existing = prev[existingIdx];
        const updatedSession: TranscriptionSession = {
          ...existing,
          title: deriveSessionTitle(transcripts, existing.createdAt),
          updatedAt: updatedTime,
          items: transcripts,
        };
        next = [
          updatedSession,
          ...prev.slice(0, existingIdx),
          ...prev.slice(existingIdx + 1),
        ];
      } else {
        const newSession: TranscriptionSession = {
          id: sessId!,
          title: deriveSessionTitle(transcripts, nowDate),
          createdAt: nowDate,
          updatedAt: updatedTime,
          items: transcripts,
        };
        next = [newSession, ...prev];
      }
      saveSessionsToStorage(next);
      return next;
    });
  }, [transcripts, autoSaveEnabled, isStorageLoaded]);

  // Fast On-Device Welsh -> English Translation (Fix #6: prohibit network fallback on live partials)
  const performTranslation = async (
    textToTranslate: string,
    allowNetworkFallback: boolean = true
  ): Promise<string> => {
    const trimmed = textToTranslate.trim();
    if (!trimmed) return '';

    // 1. Primary: On-Device Google ML Kit (Offline, Instant ~15ms)
    try {
      const res = (await TranslateText.translate({
        text: trimmed,
        sourceLanguage: TranslateLanguage.WELSH,
        targetLanguage: TranslateLanguage.ENGLISH,
        downloadModelIfNeeded: true,
      })) as unknown as string;

      if (res && typeof res === 'string' && res.trim().length > 0) {
        return res.trim();
      }
    } catch (mlKitErr) {
      // ML Kit model loading or not downloaded yet
    }

    // 2. Secondary fallback: Bangor University Techiaith API (ONLY for completed sentences, never partials)
    if (!allowNetworkFallback) {
      return '';
    }

    try {
      const encoded = encodeURIComponent(trimmed);
      const url = `https://api.techiaith.cymru/translate/v2/models/nllb200-cy-en/translate/?text=${encoded}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (resp.ok) {
        const data = await resp.json();
        const apiTranslation = data?.translations?.[0]?.translation_text;
        if (apiTranslation) return apiTranslation.trim();
      }
    } catch (apiErr) {
      console.log('Techiaith API fallback also failed:', apiErr);
    }

    return '';
  };

  // Translate live partial speech in real time (debounced, request-id guarded) (Fix #3, #6)
  const handleLivePartialTranslation = (text: string) => {
    if (!translateEnabledRef.current || !text.trim()) {
      setPartialTranslation('');
      partialTranslationRef.current = '';
      return;
    }

    if (partialTranslateTimerRef.current) {
      clearTimeout(partialTranslateTimerRef.current);
    }

    const currentReqId = ++partialRequestIdRef.current;
    partialTranslateTimerRef.current = setTimeout(async () => {
      // Pass false to never hit Techiaith network fallback during partial streaming
      const liveTrans = await performTranslation(text, false);
      if (currentReqId === partialRequestIdRef.current) {
        setPartialTranslation(liveTrans);
        partialTranslationRef.current = liveTrans;
      }
    }, 180);
  };

  // Translate completed utterance and update both active transcript list and saved sessions
  const translateCompletedItem = async (id: string, textToTranslate: string) => {
    try {
      const translated = await performTranslation(textToTranslate, true);
      setTranscripts((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                translation: translated || item.translation || undefined,
                isTranslating: false,
              }
            : item
        )
      );
      setSessions((prev) => {
        let changed = false;
        const next = prev.map((sess) => {
          if (!sess.items.some((it) => it.id === id)) return sess;
          changed = true;
          return {
            ...sess,
            items: sess.items.map((it) =>
              it.id === id
                ? {
                    ...it,
                    translation: translated || it.translation || undefined,
                    isTranslating: false,
                  }
                : it
            ),
          };
        });
        if (changed) saveSessionsToStorage(next);
        return changed ? next : prev;
      });
    } catch {
      setTranscripts((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, isTranslating: false } : item
        )
      );
    }
  };

  // Handle incoming finalized Welsh utterance (Fix #2, #3, #12)
  const handleNewUtterance = (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;

    // Invalidate pending or in-flight live partial translations (Fix #3)
    partialRequestIdRef.current++;
    if (partialTranslateTimerRef.current) {
      clearTimeout(partialTranslateTimerRef.current);
    }

    const shouldTranslate = translateEnabledRef.current;
    // Fix #12: slice instead of deprecated substr
    const newId = Date.now().toString() + Math.random().toString(36).slice(2, 7);

    // Fix #2: Read latest partial translation from ref to prevent stale closure
    const existingPartialTrans = partialTranslationRef.current;

    const newItem: TranscriptItem = {
      id: newId,
      time: getTimestamp(),
      text: trimmed,
      translation: existingPartialTrans || undefined,
      isTranslating: shouldTranslate && !existingPartialTrans,
    };

    setTranscripts((prev) => [...prev, newItem]);
    setPartialText('');
    setPartialTranslation('');
    partialTranslationRef.current = '';

    if (shouldTranslate) {
      translateCompletedItem(newId, trimmed);
    }
  };

  // Keep callback refs fresh
  handleNewUtteranceRef.current = handleNewUtterance;
  handleLivePartialTranslationRef.current = handleLivePartialTranslation;

  // Initialize Vosk model on app start (Fix #1: runs once on mount, no reload on language cycle)
  useEffect(() => {
    let isMounted = true;

    async function initVosk() {
      try {
        setCustomError(null);
        setModelStatus('initializing');

        await loadModel('model-cy');

        // Pre-warm on-device ML Kit translation in background (offline only)
        performTranslation('helo', false).catch(() => {});

        if (isMounted) {
          setModelStatus('ready');
        }
      } catch (err: any) {
        console.error('Failed to load Vosk model:', err);
        if (isMounted) {
          setModelStatus('error');
          setCustomError(err?.message || String(err) || 'Check model assets');
        }
      }
    }

    initVosk();

    // Register recognition event listeners once on mount
    const subPartial = onPartialResult((res: string) => {
      if (res && res.trim().length > 0) {
        const trimmed = res.trim();
        setPartialText(trimmed);
        handleLivePartialTranslationRef.current(trimmed);
      }
    });

    const subResult = onResult((res: string) => {
      handleNewUtteranceRef.current(res);
    });

    const subFinal = onFinalResult((res: string) => {
      handleNewUtteranceRef.current(res);
    });

    const subError = onError((err: any) => {
      console.warn('Vosk error event:', err);
      setCustomError(String(err));
      setIsRecording(false);
      setModelStatus('ready');
      deactivateKeepAwake();
    });

    return () => {
      isMounted = false;
      if (partialTranslateTimerRef.current) {
        clearTimeout(partialTranslateTimerRef.current);
      }
      subPartial.remove();
      subResult.remove();
      subFinal.remove();
      subError.remove();
    };
  }, []);

  // Start Speech Recognition (Fix #11: activate keep awake)
  const handleStart = async () => {
    try {
      setCustomError(null);
      partialRequestIdRef.current++;
      if (partialTranslateTimerRef.current) {
        clearTimeout(partialTranslateTimerRef.current);
      }
      setPartialText('');
      setPartialTranslation('');
      partialTranslationRef.current = '';

      await start();
      await activateKeepAwakeAsync();
      setIsRecording(true);
      setModelStatus('recording');
    } catch (err: any) {
      console.error('Error starting speech recognition:', err);
      Alert.alert(
        t('Gwall Meicroffon', 'Microphone Error'),
        t(
          'Methwyd cychwyn recordio. Sicrhewch fod caniatâd meicroffon wedi ei roi.',
          'Could not start recording. Please ensure microphone permissions are granted.'
        ) + `\n\n${err?.message || err}`
      );
      setIsRecording(false);
      setModelStatus('ready');
      deactivateKeepAwake();
    }
  };

  // Stop Speech Recognition (Fix #11: deactivate keep awake)
  const handleStop = async () => {
    try {
      stop();
      deactivateKeepAwake();
      setIsRecording(false);
      setModelStatus('ready');
      partialRequestIdRef.current++;
      if (partialTranslateTimerRef.current) {
        clearTimeout(partialTranslateTimerRef.current);
      }
      setPartialText('');
      setPartialTranslation('');
      partialTranslationRef.current = '';
    } catch (err: any) {
      console.error('Error stopping speech recognition:', err);
      setIsRecording(false);
      deactivateKeepAwake();
    }
  };

  // Reset live screen state for a brand new session (preserving saved session history)
  const resetToFreshSession = () => {
    partialRequestIdRef.current++;
    if (partialTranslateTimerRef.current) {
      clearTimeout(partialTranslateTimerRef.current);
    }
    currentSessionIdRef.current = null;
    setCurrentSessionId(null);
    isNearBottomRef.current = true;
    setTranscripts([]);
    setPartialText('');
    setPartialTranslation('');
    partialTranslationRef.current = '';
    setShowSessionsDropdown(false);
  };

  // Start a new discrete session
  const handleStartNewSession = () => {
    if (transcripts.length === 0 && !partialText && !currentSessionId) {
      setShowSessionsDropdown(false);
      showFeedback(
        t('Rydych eisoes mewn sesiwn newydd', 'Already in a new session')
      );
      return;
    }

    if (!autoSaveEnabled && transcripts.length > 0) {
      Alert.alert(
        t('Dechrau Sesiwn Newydd?', 'Start New Session?'),
        t(
          'Mae Cadw Lleol i ffwrdd. Hoffech chi gadw’r sesiwn bresennol cyn dechrau un newydd?',
          'Auto-save is off. Would you like to save the current session before starting a new one?'
        ),
        [
          { text: t('Canslo', 'Cancel'), style: 'cancel' },
          {
            text: t('Taflu a Newydd', 'Discard & New'),
            style: 'destructive',
            onPress: () => {
              resetToFreshSession();
              showFeedback(t('Sesiwn newydd wedi dechrau', 'Started a new session'));
            },
          },
          {
            text: t('Cadw a Newydd', 'Save & New'),
            onPress: () => {
              const nowDate = formatSessionDate();
              const sessId =
                currentSessionIdRef.current ||
                'sess_' + Date.now().toString() + Math.random().toString(36).slice(2, 6);
              const updatedTime = transcripts[transcripts.length - 1]?.time || nowDate;
              setSessions((prev) => {
                const filtered = prev.filter((s) => s.id !== sessId);
                const saved: TranscriptionSession = {
                  id: sessId,
                  title: deriveSessionTitle(transcripts, nowDate),
                  createdAt: nowDate,
                  updatedAt: updatedTime,
                  items: transcripts,
                };
                const next = [saved, ...filtered];
                saveSessionsToStorage(next, true);
                return next;
              });
              resetToFreshSession();
              showFeedback(
                t('Cadwyd yr hen sesiwn a dechreuwyd un newydd', 'Saved session & started new')
              );
            },
          },
        ]
      );
      return;
    }

    resetToFreshSession();
    showFeedback(
      t(
        'Sesiwn newydd wedi dechrau (cadwyd yr hen sesiwn)',
        'Started new session (previous session saved)'
      )
    );
  };

  // Load / resume a discrete session from history
  const handleLoadSession = (session: TranscriptionSession) => {
    partialRequestIdRef.current++;
    if (partialTranslateTimerRef.current) {
      clearTimeout(partialTranslateTimerRef.current);
    }
    currentSessionIdRef.current = session.id;
    setCurrentSessionId(session.id);
    isNearBottomRef.current = true;
    setTranscripts(session.items);
    setPartialText('');
    setPartialTranslation('');
    partialTranslationRef.current = '';
    setShowSessionsDropdown(false);
    showFeedback(
      t(
        `Adferwyd sesiwn (${session.items.length} brawddeg)`,
        `Resumed session (${session.items.length} sentences)`
      )
    );
  };

  // Delete a specific saved session
  const handleDeleteSession = (sessionId: string) => {
    Alert.alert(
      t('Dileu Sesiwn?', 'Delete Session?'),
      t(
        'A ydych yn siŵr eich bod am ddileu’r sesiwn hon o gof y ddyfais?',
        'Are you sure you want to delete this session from device storage?'
      ),
      [
        { text: t('Canslo', 'Cancel'), style: 'cancel' },
        {
          text: t('Dileu', 'Delete'),
          style: 'destructive',
          onPress: () => {
            setSessions((prev) => {
              const next = prev.filter((s) => s.id !== sessionId);
              saveSessionsToStorage(next, true);
              return next;
            });
            if (currentSessionIdRef.current === sessionId) {
              resetToFreshSession();
            }
            showFeedback(t('Sesiwn wedi’i dileu', 'Session deleted'));
          },
        },
      ]
    );
  };

  // Delete all saved sessions
  const handleDeleteAllSessions = () => {
    if (sessions.length === 0) return;
    Alert.alert(
      t('Dileu Pob Sesiwn?', 'Delete All Sessions?'),
      t(
        'A ydych yn siŵr eich bod am ddileu pob sesiwn sydd wedi’i chadw ar y ddyfais?',
        'Are you sure you want to delete all saved sessions from device storage?'
      ),
      [
        { text: t('Canslo', 'Cancel'), style: 'cancel' },
        {
          text: t('Dileu Popeth', 'Delete All'),
          style: 'destructive',
          onPress: () => {
            setSessions([]);
            saveSessionsToStorage([], true);
            currentSessionIdRef.current = null;
            setCurrentSessionId(null);
            showFeedback(t('Pob sesiwn wedi’i dileu', 'All saved sessions deleted'));
          },
        },
      ]
    );
  };

  // Clear Current Session or Start New
  const handleClear = () => {
    if (transcripts.length === 0 && !partialText) return;
    Alert.alert(
      t('Clirio’r Sesiwn Gyfredol?', 'Clear Current Session?'),
      currentSessionId && autoSaveEnabled
        ? t(
            'Gallwch ddechrau sesiwn newydd (gan gadw’r un hon yn eich hanes) neu ddileu’r sesiwn hon yn llwyr.',
            'You can start a new session (keeping this one in history) or permanently delete this session.'
          )
        : t(
            'A ydych yn siŵr eich bod am glirio’r trawsgrifiadau presennol o’r sgrin?',
            'Are you sure you want to clear the current transcriptions from the screen?'
          ),
      currentSessionId && autoSaveEnabled
        ? [
            { text: t('Canslo', 'Cancel'), style: 'cancel' },
            {
              text: t('Sesiwn Newydd', 'Start New Session'),
              onPress: () => {
                resetToFreshSession();
                showFeedback(
                  t('Sesiwn newydd (cadwyd yr hen un)', 'New session (previous saved)')
                );
              },
            },
            {
              text: t('Dileu’r Sesiwn Hon', 'Delete This Session'),
              style: 'destructive',
              onPress: () => {
                const idToDelete = currentSessionIdRef.current;
                if (idToDelete) {
                  setSessions((prev) => {
                    const next = prev.filter((s) => s.id !== idToDelete);
                    saveSessionsToStorage(next, true);
                    return next;
                  });
                }
                resetToFreshSession();
                showFeedback(t('Sesiwn wedi’i dileu', 'Session deleted'));
              },
            },
          ]
        : [
            { text: t('Canslo', 'Cancel'), style: 'cancel' },
            {
              text: t('Clirio', 'Clear'),
              style: 'destructive',
              onPress: () => {
                resetToFreshSession();
                showFeedback(t('Wedi clirio’r sgrin', 'Screen cleared'));
              },
            },
          ]
    );
  };

  // Toggle local device storage auto-save
  const toggleAutoSave = () => {
    const next = !autoSaveEnabled;
    setAutoSaveEnabled(next);
    saveSettingsToStorage({ autoSaveEnabled: next });
    if (next) {
      showFeedback(
        t(
          'Cadw lleol: YMLAEN (yn cadw sesiynau ar y ddyfais)',
          'Local storage: ON (sessions saved on device)'
        )
      );
    } else {
      showFeedback(
        t(
          'Cadw lleol: I FFWRDD (dim ond am y sesiwn hon)',
          'Local storage: OFF (current session not auto-saved)'
        )
      );
    }
  };

  // Copy with timestamps & translations
  const handleCopyWithTimestamps = async () => {
    if (transcripts.length === 0) {
      showFeedback(t('Dim trawsgrifiad i’w gopïo', 'No transcriptions to copy'));
      return;
    }
    const formatted = transcripts
      .map((item) => {
        let block = `[${item.time}] ${item.text}`;
        if (item.translation) {
          block += `\n    ↳ [EN] ${item.translation}`;
        }
        return block;
      })
      .join('\n\n');

    await Clipboard.setStringAsync(formatted);
    showFeedback(
      t('Wedi copïo gydag amseroedd a chyfieithiadau!', 'Copied with timestamps & translations!')
    );
  };

  // Copy text only (original + translation under it)
  const handleCopyTextOnly = async () => {
    if (transcripts.length === 0) {
      showFeedback(t('Dim trawsgrifiad i’w gopïo', 'No transcriptions to copy'));
      return;
    }
    const formatted = transcripts
      .map((item) => {
        if (item.translation) {
          return `${item.text}\n(${item.translation})`;
        }
        return item.text;
      })
      .join('\n\n');

    await Clipboard.setStringAsync(formatted);
    showFeedback(t('Wedi copïo testun a chyfieithiadau!', 'Copied text & translations!'));
  };

  // Native Mobile Share (Welsh + English)
  const handleShare = async () => {
    if (transcripts.length === 0) {
      showFeedback(t('Dim trawsgrifiad i’w rannu', 'No transcriptions to share'));
      return;
    }
    const formatted = transcripts
      .map((item) => {
        let block = `[${item.time}] ${item.text}`;
        if (item.translation) {
          block += `\n    ↳ [EN] ${item.translation}`;
        }
        return block;
      })
      .join('\n\n');

    try {
      await Share.share({
        title: 'Trawsgrifiad a Chyfieithiad Cymraeg',
        message: formatted,
      });
    } catch (error: any) {
      console.warn('Share error:', error);
    }
  };

  // Cycle language mode
  const cycleLanguage = () => {
    const next: LanguageMode =
      langMode === 'bilingual' ? 'cy' : langMode === 'cy' ? 'en' : 'bilingual';
    setLangMode(next);
    saveSettingsToStorage({ langMode: next });
  };

  // Toggle real-time translation
  const toggleTranslation = () => {
    const next = !translateEnabled;
    setTranslateEnabled(next);
    translateEnabledRef.current = next;
    saveSettingsToStorage({ translateEnabled: next });
    if (!next) {
      partialRequestIdRef.current++;
      if (partialTranslateTimerRef.current) {
        clearTimeout(partialTranslateTimerRef.current);
      }
      setPartialTranslation('');
      partialTranslationRef.current = '';
    }
    showFeedback(
      next
        ? t('Cyfieithu Byw wedi’i alluogi (Lleol / Ar-ddyfais)', 'Live On-Device Translation Enabled')
        : t('Cyfieithu wedi’i ddiffodd', 'Translation disabled')
    );
  };

  // Status indicator styling
  const getStatusColor = () => {
    switch (modelStatus) {
      case 'recording':
        return '#EF4444'; // Red
      case 'ready':
        return '#10B981'; // Green
      case 'initializing':
        return '#F59E0B'; // Amber
      case 'error':
        return '#EF4444';
    }
  };

  // Accurate dynamic safe padding using react-native-safe-area-context
  const androidStatusBar = RNStatusBar.currentHeight || 44;
  const topPadding = Math.max(insets.top + 8, androidStatusBar + 12);
  const bottomPadding = Math.max(insets.bottom + 12, 32);

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.bg,
          paddingTop: topPadding,
          paddingBottom: bottomPadding,
        },
      ]}
    >
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />

      {/* Header with generous margins and padding */}
      <View style={styles.header}>
        {/* Clickable Header Logo for Info & Licences */}
        <TouchableOpacity
          style={styles.logoButton}
          onPress={() => setShowAboutModal(true)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Trawsgrifiwr Byw"
          accessibilityHint={t('Agor gwybodaeth am y rhaglen a thrwyddedau', 'Open app information and licences')}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Image
            source={require('./assets/icon.png')}
            style={styles.headerLogo}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
        </TouchableOpacity>

        {/* Top Header Buttons with 44px+ touch targets */}
        <View style={styles.headerButtons}>
          {/* Settings Menu Button */}
          <TouchableOpacity
            style={[styles.headerIconButton, { backgroundColor: theme.toggleInactiveBg }]}
            onPress={() => setShowSettingsModal(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            activeOpacity={0.7}
          >
            <Ionicons
              name="settings-outline"
              size={19}
              color={theme.headerText}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Feedback Toast */}
      {feedbackMessage && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{feedbackMessage}</Text>
        </View>
      )}

      {/* Live Input Card (Red Section with integrated live status) */}
      <View style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}>
        <View style={styles.liveHeader}>
          <View style={styles.headerRow}>
            <View style={[styles.statusDot, { backgroundColor: getStatusColor(), marginRight: 4 }]} />
            <Text style={styles.liveHeaderText} numberOfLines={1}>
              {getStatusText()}
            </Text>
            {modelStatus === 'initializing' && (
              <ActivityIndicator size="small" color="#FFFFFF" style={{ marginLeft: 4 }} />
            )}
          </View>
          {isRecording && (
            <View style={styles.liveBadge}>
              <View style={styles.liveIndicator} />
              <Text style={styles.liveBadgeText}>
                {langMode === 'cy' ? 'BYW' : 'LIVE'}
              </Text>
            </View>
          )}
        </View>

        <View style={[styles.liveContent, { backgroundColor: theme.liveBoxBg }]}>
          {/* Live Welsh words */}
          <Text
            style={[
              styles.liveText,
              { fontSize: fontSize + 1, color: theme.liveText },
              !partialText && styles.placeholderText,
            ]}
          >
            {partialText ||
              t(
                'Bydd trawsgrifiad rhannol yn ymddangos yma wrth siarad...',
                'Partial transcription will appear here as you speak...'
              )}
          </Text>

          {/* Live English translation right under it */}
          {translateEnabled && partialTranslation ? (
            <View style={[styles.liveTranslationRow, { borderTopColor: theme.liveBorder }]}>
              <Ionicons name="return-down-forward" size={14} color="#10B981" />
              <Text style={[styles.liveTranslationTag, { backgroundColor: theme.liveTranslationBg, color: theme.liveTranslationText }]}>
                EN
              </Text>
              <Text style={[styles.liveTranslationText, { fontSize, color: theme.liveTranslationText }]}>
                {partialTranslation}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Completed Transcriptions Card (Green Section) */}
      <View
        style={[
          styles.card,
          styles.transcriptsCard,
          { backgroundColor: theme.cardBg, borderColor: theme.cardBorder },
        ]}
      >
        {/* Completed Header with clean flex layout */}
        <View style={styles.completedHeader}>
          <View style={styles.headerTitleGroup}>
            <Ionicons name="chatbubbles-outline" size={18} color="#FFFFFF" />
            {transcripts.length > 0 && (
              <View style={styles.countBadge}>
                <Text style={styles.countBadgeText}>{transcripts.length}</Text>
              </View>
            )}
          </View>

          {/* Right Header Controls: New Session, Session History Dropdown Trigger */}
          <View style={styles.headerRightControls}>
            {/* Start New Session Button */}
            {(transcripts.length > 0 || currentSessionId !== null) && (
              <TouchableOpacity
                onPress={handleStartNewSession}
                style={[styles.saveToggleBtn, styles.saveToggleBtnActive]}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                activeOpacity={0.7}
              >
                <Ionicons name="add" size={15} color="#FFFFFF" />
                <Text style={styles.saveToggleBtnText}>
                  {langMode === 'en' ? 'NEW' : 'NEWYDD'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Sessions History Dropdown Button */}
            <TouchableOpacity
              onPress={() => setShowSessionsDropdown((prev) => !prev)}
              style={[
                styles.saveToggleBtn,
                showSessionsDropdown ? styles.saveToggleBtnActiveSolid : styles.saveToggleBtnActive,
              ]}
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              activeOpacity={0.7}
            >
              <Ionicons
                name={showSessionsDropdown ? 'chevron-up' : 'folder-open-outline'}
                size={13}
                color="#FFFFFF"
              />
              <Text style={styles.saveToggleBtnText}>
                {langMode === 'en' ? 'SESSIONS' : 'HANES'}
                {sessions.length > 0 ? ` (${sessions.length})` : ''}
              </Text>
              <Ionicons
                name={showSessionsDropdown ? 'chevron-up' : 'chevron-down'}
                size={11}
                color="#FFFFFF"
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* Inline Sessions Dropdown Menu */}
        {showSessionsDropdown && (
          <View
            style={[
              styles.sessionsDropdownContainer,
              { backgroundColor: theme.transcriptBoxBg, borderColor: theme.cardBorder },
            ]}
          >
            <View style={styles.sessionsDropdownHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.sessionsDropdownTitle, { color: theme.headerText }]}>
                  {t('Hanes Sesiynau', 'Session History')}
                </Text>
                <Text style={[styles.sessionsDropdownSubtitle, { color: theme.subText }]}>
                  {sessions.length === 0
                    ? t('Dim sesiynau wedi’u cadw', 'No saved sessions')
                    : t(
                        `${sessions.length} sesiwn ar y ddyfais`,
                        `${sessions.length} saved sessions on device`
                      )}
                </Text>
              </View>

              <TouchableOpacity
                onPress={handleStartNewSession}
                style={[styles.dropdownNewBtn, { backgroundColor: '#00843D' }]}
                activeOpacity={0.8}
              >
                <Ionicons name="add" size={14} color="#FFFFFF" />
                <Text style={styles.dropdownNewBtnText}>
                  {t('+ Sesiwn Newydd', '+ New Session')}
                </Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.sessionsDropdownScroll}
              nestedScrollEnabled={true}
              showsVerticalScrollIndicator={true}
            >
              {sessions.length === 0 ? (
                <View style={styles.emptyDropdownStateBox}>
                  <Ionicons name="folder-open-outline" size={28} color={theme.subText} />
                  <Text style={[styles.emptyDropdownStateText, { color: theme.subText }]}>
                    {t(
                      'Dim sesiynau wedi’u cadw eto. Bydd eich trawsgrifiadau yn ymddangos yma wrth siarad.',
                      'No saved sessions yet. Transcribed speech will be listed here.'
                    )}
                  </Text>
                </View>
              ) : (
                sessions.map((session) => {
                  const isActive = session.id === currentSessionId;
                  const firstTranslation = session.items[0]?.translation;
                  return (
                    <TouchableOpacity
                      key={session.id}
                      style={[
                        styles.dropdownSessionRow,
                        {
                          backgroundColor: isActive
                            ? (isDarkMode ? '#1E3A2F' : '#E6F4EA')
                            : theme.cardBg,
                          borderColor: isActive ? '#10B981' : theme.cardBorder,
                        },
                      ]}
                      onPress={() => handleLoadSession(session)}
                      activeOpacity={0.7}
                    >
                      <View style={{ flex: 1, paddingRight: 6 }}>
                        <View style={styles.dropdownSessionMetaRow}>
                          <Text style={[styles.dropdownSessionDate, { color: theme.subText }]}>
                            {session.createdAt}
                          </Text>
                          <View
                            style={[
                              styles.sessionCountPill,
                              { backgroundColor: theme.timeBadgeBg },
                            ]}
                          >
                            <Text
                              style={[
                                styles.sessionCountPillText,
                                { color: theme.timeBadgeText },
                              ]}
                            >
                              {session.items.length}{' '}
                              {langMode === 'cy'
                                ? 'brawddeg'
                                : langMode === 'en'
                                ? 'sentences'
                                : 'brawddeg'}
                            </Text>
                          </View>
                          {isActive && (
                            <View style={styles.activeSessionBadge}>
                              <Text style={styles.activeSessionBadgeText}>
                                {langMode === 'en' ? 'ACTIVE' : 'CYFREDOL'}
                              </Text>
                            </View>
                          )}
                        </View>

                        <Text
                          style={[
                            styles.dropdownSessionTitle,
                            { color: theme.headerText },
                          ]}
                          numberOfLines={1}
                        >
                          “{session.title}”
                        </Text>

                        {firstTranslation ? (
                          <Text
                            style={[
                              styles.dropdownSessionTranslation,
                              { color: theme.translationText },
                            ]}
                            numberOfLines={1}
                          >
                            ↳ [EN] {firstTranslation}
                          </Text>
                        ) : null}
                      </View>

                      <View style={styles.dropdownRowActions}>
                        <TouchableOpacity
                          style={[
                            styles.dropdownDeleteBtn,
                            { backgroundColor: isDarkMode ? '#3B1519' : '#FEE2E2' },
                          ]}
                          onPress={(e) => {
                            e.stopPropagation();
                            handleDeleteSession(session.id);
                          }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          activeOpacity={0.7}
                        >
                          <Ionicons name="trash-outline" size={14} color="#EF4444" />
                        </TouchableOpacity>
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>

            {sessions.length > 0 && (
              <View style={[styles.dropdownFooterRow, { borderTopColor: theme.cardBorder }]}>
                <TouchableOpacity
                  style={styles.dropdownClearAllBtn}
                  onPress={handleDeleteAllSessions}
                  activeOpacity={0.7}
                >
                  <Ionicons name="trash-outline" size={13} color="#EF4444" />
                  <Text style={styles.dropdownClearAllText}>
                    {t('Dileu Pob Sesiwn', 'Delete All')}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.dropdownCloseBtn, { backgroundColor: theme.btnSecondaryBg }]}
                  onPress={() => setShowSessionsDropdown(false)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.dropdownCloseText, { color: theme.btnSecondaryText }]}>
                    {t('Cau’r Ddewislen', 'Close Dropdown')}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Virtualized Transcripts List (Fix #9) */}
        <FlatList
          ref={flatListRef}
          data={transcripts}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View
              style={[
                styles.transcriptItemCard,
                { backgroundColor: theme.cardBg, borderColor: theme.cardBorder },
              ]}
            >
              {/* Original Welsh Utterance */}
              <View style={styles.transcriptLine}>
                {showTimestamps && (
                  <View style={[styles.timeBadge, { backgroundColor: theme.timeBadgeBg }]}>
                    <Text style={[styles.timeText, { color: theme.timeBadgeText }]}>
                      {item.time}
                    </Text>
                  </View>
                )}
                <Text style={[styles.transcriptText, { fontSize, color: theme.transcriptText }]}>
                  {item.text}
                </Text>
              </View>

              {/* Translating Spinner */}
              {item.isTranslating && (
                <View style={styles.translatingRow}>
                  <ActivityIndicator size="small" color="#10B981" />
                  <Text style={[styles.translatingText, { color: theme.subText }]}>
                    {t('Yn cyfieithu...', 'Translating...')}
                  </Text>
                </View>
              )}

              {/* English Translation */}
              {item.translation ? (
                <View
                  style={[
                    styles.translationCard,
                    {
                      backgroundColor: theme.translationCardBg,
                      borderLeftColor: theme.translationBorder,
                    },
                  ]}
                >
                  <View style={styles.translationHeaderRow}>
                    <Ionicons name="return-down-forward" size={15} color={theme.translationBorder} />
                    <Text style={[styles.translationLangTag, { color: theme.translationBorder }]}>
                      EN
                    </Text>
                  </View>
                  <Text style={[styles.translationText, { fontSize: fontSize - 0.5, color: theme.translationText }]}>
                    {item.translation}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
          style={[styles.scrollArea, { backgroundColor: theme.transcriptBoxBg }]}
          contentContainerStyle={styles.scrollContent}
          scrollEventThrottle={16}
          onScroll={(e) => {
            const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
            isNearBottomRef.current =
              layoutMeasurement.height + contentOffset.y >= contentSize.height - 80;
          }}
          onContentSizeChange={() => {
            if (isNearBottomRef.current && transcripts.length > 0) {
              flatListRef.current?.scrollToEnd({ animated: true });
            }
          }}
          ListEmptyComponent={
            <View>
              <Text style={[styles.placeholderText, { fontSize, color: theme.subText }]}>
                {autoSaveEnabled
                  ? t(
                      'Sesiwn newydd yn barod. Bydd brawddegau cyflawn yn cael eu cadw yn awtomatig...',
                      'New session ready. Completed sentences will be saved automatically...'
                    )
                  : t(
                      'Sesiwn newydd yn barod. Bydd brawddegau cyflawn yn ymddangos yma...',
                      'New session ready. Completed sentences will appear here...'
                    )}
              </Text>

              {sessions.length > 0 && (
                <View
                  style={[
                    styles.emptySessionBanner,
                    { backgroundColor: theme.cardBg, borderColor: theme.cardBorder },
                  ]}
                >
                  <View style={styles.emptySessionBannerHeader}>
                    <View style={styles.emptySessionTitleRow}>
                      <Ionicons name="time-outline" size={16} color="#10B981" />
                      <Text style={[styles.emptySessionBannerTitle, { color: theme.headerText }]}>
                        {t('Sesiwn Ddiwethaf', 'Previous Session')} ({sessions[0].items.length})
                      </Text>
                    </View>
                    <Text style={[styles.emptySessionDate, { color: theme.subText }]}>
                      {sessions[0].createdAt}
                    </Text>
                  </View>

                  <Text
                    style={[styles.emptySessionPreview, { color: theme.transcriptText }]}
                    numberOfLines={2}
                  >
                    “{sessions[0].title}”
                  </Text>

                  <View style={styles.emptySessionActions}>
                    <TouchableOpacity
                      style={[styles.emptySessionPrimaryBtn, { backgroundColor: '#00843D' }]}
                      onPress={() => handleLoadSession(sessions[0])}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="play-outline" size={15} color="#FFFFFF" />
                      <Text style={styles.emptySessionPrimaryBtnText}>
                        {t('Adfer Sesiwn', 'Resume Session')}
                      </Text>
                    </TouchableOpacity>

                    {sessions.length > 1 && (
                      <TouchableOpacity
                        style={[
                          styles.emptySessionSecondaryBtn,
                          { backgroundColor: theme.btnSecondaryBg },
                        ]}
                        onPress={() => setShowSessionsDropdown(true)}
                        activeOpacity={0.8}
                      >
                        <Ionicons
                          name="chevron-down-circle-outline"
                          size={15}
                          color={theme.btnSecondaryText}
                        />
                        <Text
                          style={[
                            styles.emptySessionSecondaryBtnText,
                            { color: theme.btnSecondaryText },
                          ]}
                        >
                          {t(
                            `Pob Sesiwn (${sessions.length})`,
                            `All Sessions (${sessions.length})`
                          )}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              )}
            </View>
          }
        />

        {/* Quick Action Toolbar with comfortable padding and large tap targets */}
        <View style={[styles.transcriptActions, { backgroundColor: theme.toolbarBg, borderColor: theme.toolbarBorder }]}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: theme.btnSecondaryBg }]}
            onPress={handleCopyTextOnly}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            activeOpacity={0.7}
          >
            <Ionicons name="copy-outline" size={16} color={theme.btnSecondaryText} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: theme.btnSecondaryBg }]}
            onPress={handleShare}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            activeOpacity={0.7}
          >
            <Ionicons name="share-outline" size={16} color={theme.btnSecondaryText} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, styles.clearBtn, { backgroundColor: isDarkMode ? '#3B1519' : '#FEE2E2' }]}
            onPress={handleClear}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            activeOpacity={0.7}
          >
            <Ionicons name="trash-outline" size={16} color="#EF4444" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Microphone Button with generous margins away from phone corners */}
      <View style={styles.footerControls}>
        <View style={styles.micButtonWrapper}>
          {isRecording && <View style={styles.micPulseRing} />}
          <TouchableOpacity
            style={[
              styles.micButton,
              isRecording ? styles.micButtonRecording : styles.micButtonReady,
              modelStatus === 'initializing' && styles.micButtonDisabled,
            ]}
            onPress={isRecording ? handleStop : handleStart}
            disabled={modelStatus === 'initializing'}
            accessibilityRole="button"
            accessibilityLabel={
              isRecording
                ? t('Stopio Recordio', 'Stop Recording')
                : t('Dechrau Recordio', 'Start Recording')
            }
            accessibilityState={{ disabled: modelStatus === 'initializing', busy: isRecording }}
            activeOpacity={0.82}
          >
            <Ionicons
              name={isRecording ? 'square' : 'mic'}
              size={32}
              color="#FFFFFF"
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Settings Modal */}
      <Modal
        visible={showSettingsModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowSettingsModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalCard,
              { backgroundColor: theme.cardBg, borderColor: theme.cardBorder },
            ]}
          >
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.modalTitle, { color: theme.headerText }]}>
                  {t('Gosodiadau', 'Settings')}
                </Text>
                <Text style={[styles.modalSubtitle, { color: theme.subText }]}>
                  {t('Dewisiadau iaith, maint ac arddull', 'Language, sizing & theme preferences')}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowSettingsModal(false)}
                style={[styles.modalCloseButton, { backgroundColor: theme.toggleInactiveBg }]}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.7}
              >
                <Ionicons name="close" size={20} color={theme.headerText} />
              </TouchableOpacity>
            </View>

            {/* Modal Body */}
            <ScrollView
              style={styles.modalBody}
              contentContainerStyle={{ paddingBottom: 16 }}
              showsVerticalScrollIndicator={true}
            >
              {/* 1. Theme / Dark Mode */}
              <View style={[styles.settingsItemRow, { borderColor: theme.cardBorder }]}>
                <View style={styles.settingsLabelGroup}>
                  <View style={styles.settingsLabelRow}>
                    <Ionicons
                      name={isDarkMode ? 'moon' : 'sunny'}
                      size={18}
                      color={isDarkMode ? '#FBBF24' : '#00843D'}
                    />
                    <Text style={[styles.settingsItemTitle, { color: theme.headerText }]}>
                      {t('Modd Tywyll', 'Dark Mode')}
                    </Text>
                  </View>
                  <Text style={[styles.settingsItemDesc, { color: theme.subText }]}>
                    {isDarkMode
                      ? t('Thema dywyll ar waith', 'Dark theme active')
                      : t('Thema olau ar waith', 'Light theme active')}
                  </Text>
                </View>
                <Switch
                  value={isDarkMode}
                  onValueChange={(val) => {
                    setIsDarkMode(val);
                    saveSettingsToStorage({ isDarkMode: val });
                  }}
                  trackColor={{ false: '#94A3B8', true: '#00843D' }}
                  thumbColor="#FFFFFF"
                />
              </View>

              {/* 2. Live Translation Toggle */}
              <View style={[styles.settingsItemRow, { borderColor: theme.cardBorder }]}>
                <View style={styles.settingsLabelGroup}>
                  <View style={styles.settingsLabelRow}>
                    <Ionicons name="language-outline" size={18} color="#00843D" />
                    <Text style={[styles.settingsItemTitle, { color: theme.headerText }]}>
                      {t('Cyfieithu Byw (Cymraeg → Saesneg)', 'Live Translation (Welsh → English)')}
                    </Text>
                  </View>
                  <Text style={[styles.settingsItemDesc, { color: theme.subText }]}>
                    {translateEnabled
                      ? t(
                          'Yn cyfieithu ar-ddyfais all-lein wrth i chi siarad',
                          'Translating on-device offline as you speak'
                        )
                      : t('Cyfieithu wedi’i analluogi', 'Translation is turned off')}
                  </Text>
                </View>
                <Switch
                  value={translateEnabled}
                  onValueChange={toggleTranslation}
                  trackColor={{ false: '#94A3B8', true: '#00843D' }}
                  thumbColor="#FFFFFF"
                />
              </View>

              {/* 3. Timestamps Toggle */}
              <View style={[styles.settingsItemRow, { borderColor: theme.cardBorder }]}>
                <View style={styles.settingsLabelGroup}>
                  <View style={styles.settingsLabelRow}>
                    <Ionicons name="time-outline" size={18} color="#00843D" />
                    <Text style={[styles.settingsItemTitle, { color: theme.headerText }]}>
                      {t('Dangos Stampiau Amser', 'Show Timestamps')}
                    </Text>
                  </View>
                  <Text style={[styles.settingsItemDesc, { color: theme.subText }]}>
                    {showTimestamps
                      ? t(
                          'Stamp amser [HH:mm:ss] yn ymddangos wrth bob brawddeg',
                          '[HH:mm:ss] timestamp shown on each sentence'
                        )
                      : t(
                          'Cuddio stampiau amser ar y sgrin',
                          'Hide timestamps from transcript display'
                        )}
                  </Text>
                </View>
                <Switch
                  value={showTimestamps}
                  onValueChange={(val) => {
                    setShowTimestamps(val);
                    saveSettingsToStorage({ showTimestamps: val });
                    showFeedback(
                      val
                        ? t('Stampiau amser ymlaen', 'Timestamps enabled')
                        : t('Stampiau amser i ffwrdd', 'Timestamps hidden')
                    );
                  }}
                  trackColor={{ false: '#94A3B8', true: '#00843D' }}
                  thumbColor="#FFFFFF"
                />
              </View>

              {/* 4. Local Storage Auto-save Toggle */}
              <View style={[styles.settingsItemRow, { borderColor: theme.cardBorder }]}>
                <View style={styles.settingsLabelGroup}>
                  <View style={styles.settingsLabelRow}>
                    <Ionicons name="save-outline" size={18} color="#00843D" />
                    <Text style={[styles.settingsItemTitle, { color: theme.headerText }]}>
                      {t('Cadw Sesiynau yn Awtomatig', 'Auto-save Sessions')}
                    </Text>
                  </View>
                  <Text style={[styles.settingsItemDesc, { color: theme.subText }]}>
                    {autoSaveEnabled
                      ? t(
                          'Yn cadw sesiynau ar y ddyfais yn awtomatig',
                          'Automatically saves discrete sessions on device'
                        )
                      : t(
                          'Dim ond am y sesiwn bresennol (ni chedwir ar ôl cau)',
                          'Temporary only (not auto-saved to device storage)'
                        )}
                  </Text>
                </View>
                <Switch
                  value={autoSaveEnabled}
                  onValueChange={toggleAutoSave}
                  trackColor={{ false: '#94A3B8', true: '#00843D' }}
                  thumbColor="#FFFFFF"
                />
              </View>

              {/* 5. Text Scaling / Font Size */}
              <View style={[styles.settingsSectionBox, { borderColor: theme.cardBorder, backgroundColor: theme.transcriptBoxBg }]}>
                <View style={styles.settingsLabelRow}>
                  <Ionicons name="text-outline" size={18} color="#00843D" />
                  <Text style={[styles.settingsItemTitle, { color: theme.headerText }]}>
                    {t('Maint y Testun', 'Text Size')}
                  </Text>
                  <Text style={[styles.settingsFontSizeBadge, { backgroundColor: theme.timeBadgeBg, color: theme.timeBadgeText }]}>
                    {fontSize}px
                  </Text>
                </View>
                <Text style={[styles.settingsItemDesc, { color: theme.subText, marginTop: 4, marginBottom: 12 }]}>
                  {t(
                    'Addaswch faint y ffont ar gyfer darllen yn haws.',
                    'Adjust font size across the live box and transcripts.'
                  )}
                </Text>

                <View style={styles.settingsFontControlsRow}>
                  <TouchableOpacity
                    style={[
                      styles.settingsFontBtn,
                      { backgroundColor: theme.btnSecondaryBg },
                      fontSize <= 12 && styles.settingsBtnDisabled,
                    ]}
                    onPress={() => {
                      setFontSize((s) => {
                        const next = Math.max(12, s - 2);
                        saveSettingsToStorage({ fontSize: next });
                        return next;
                      });
                    }}
                    disabled={fontSize <= 12}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="remove" size={18} color={theme.btnSecondaryText} />
                    <Text style={[styles.settingsFontBtnText, { color: theme.btnSecondaryText }]}>
                      A−
                    </Text>
                  </TouchableOpacity>

                  {/* Font Size Preview */}
                  <View style={styles.settingsFontPreviewBox}>
                    <Text
                      style={[
                        styles.settingsFontPreviewText,
                        { fontSize, color: theme.transcriptText },
                      ]}
                      numberOfLines={1}
                    >
                      {t('Cymraeg Sampl', 'Sample Text')}
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={[
                      styles.settingsFontBtn,
                      { backgroundColor: theme.btnSecondaryBg },
                      fontSize >= 26 && styles.settingsBtnDisabled,
                    ]}
                    onPress={() => {
                      setFontSize((s) => {
                        const next = Math.min(26, s + 2);
                        saveSettingsToStorage({ fontSize: next });
                        return next;
                      });
                    }}
                    disabled={fontSize >= 26}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="add" size={18} color={theme.btnSecondaryText} />
                    <Text style={[styles.settingsFontBtnText, { color: theme.btnSecondaryText }]}>
                      A+
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* 4. UI Language Choice */}
              <View style={[styles.settingsSectionBox, { borderColor: theme.cardBorder, backgroundColor: theme.transcriptBoxBg }]}>
                <View style={styles.settingsLabelRow}>
                  <Ionicons name="globe-outline" size={18} color="#00843D" />
                  <Text style={[styles.settingsItemTitle, { color: theme.headerText }]}>
                    {t('Iaith y Rhyngwyneb', 'Interface Language')}
                  </Text>
                </View>
                <Text style={[styles.settingsItemDesc, { color: theme.subText, marginTop: 4, marginBottom: 12 }]}>
                  {t(
                    'Dewiswch yr iaith ar gyfer botymau a thestun y rhaglen.',
                    'Choose the display language for buttons and labels.'
                  )}
                </Text>

                <View style={styles.settingsLangPillsRow}>
                  {/* Bilingual */}
                  <TouchableOpacity
                    style={[
                      styles.settingsLangPill,
                      { borderColor: theme.cardBorder },
                      langMode === 'bilingual'
                        ? { backgroundColor: '#00843D', borderColor: '#00843D' }
                        : { backgroundColor: theme.cardBg },
                    ]}
                    onPress={() => {
                      setLangMode('bilingual');
                      saveSettingsToStorage({ langMode: 'bilingual' });
                    }}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.settingsLangPillText,
                        { color: langMode === 'bilingual' ? '#FFFFFF' : theme.headerText },
                      ]}
                    >
                      Dwyieithog (CY/EN)
                    </Text>
                  </TouchableOpacity>

                  {/* Welsh */}
                  <TouchableOpacity
                    style={[
                      styles.settingsLangPill,
                      { borderColor: theme.cardBorder },
                      langMode === 'cy'
                        ? { backgroundColor: '#00843D', borderColor: '#00843D' }
                        : { backgroundColor: theme.cardBg },
                    ]}
                    onPress={() => {
                      setLangMode('cy');
                      saveSettingsToStorage({ langMode: 'cy' });
                    }}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.settingsLangPillText,
                        { color: langMode === 'cy' ? '#FFFFFF' : theme.headerText },
                      ]}
                    >
                      Cymraeg (CY)
                    </Text>
                  </TouchableOpacity>

                  {/* English */}
                  <TouchableOpacity
                    style={[
                      styles.settingsLangPill,
                      { borderColor: theme.cardBorder },
                      langMode === 'en'
                        ? { backgroundColor: '#00843D', borderColor: '#00843D' }
                        : { backgroundColor: theme.cardBg },
                    ]}
                    onPress={() => {
                      setLangMode('en');
                      saveSettingsToStorage({ langMode: 'en' });
                    }}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.settingsLangPillText,
                        { color: langMode === 'en' ? '#FFFFFF' : theme.headerText },
                      ]}
                    >
                      English (EN)
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* 5. Link to About & Licences */}
              <TouchableOpacity
                style={[
                  styles.settingsAboutRow,
                  { backgroundColor: theme.transcriptBoxBg, borderColor: theme.cardBorder },
                ]}
                onPress={() => {
                  setShowSettingsModal(false);
                  setShowAboutModal(true);
                }}
                activeOpacity={0.7}
              >
                <View style={styles.settingsLabelRow}>
                  <Ionicons name="information-circle-outline" size={18} color="#00843D" />
                  <Text style={[styles.settingsItemTitle, { color: theme.headerText }]}>
                    {t('Gwybodaeth', 'About')}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.subText} />
              </TouchableOpacity>
            </ScrollView>

            {/* Bottom Close Button */}
            <TouchableOpacity
              style={[styles.modalBottomCloseBtn, { backgroundColor: '#00843D', marginTop: 10 }]}
              onPress={() => setShowSettingsModal(false)}
              activeOpacity={0.8}
            >
              <Text style={styles.modalBottomCloseText}>
                {t('Cau', 'Close')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* About & Licences Modal */}
      <Modal
        visible={showAboutModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowAboutModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalCard,
              { backgroundColor: theme.cardBg, borderColor: theme.cardBorder },
            ]}
          >
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <View style={styles.aboutHeaderLeft}>
                <Image
                  source={require('./assets/icon.png')}
                  style={styles.aboutModalLogo}
                  resizeMode="contain"
                  accessibilityIgnoresInvertColors
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.modalTitle, { color: theme.headerText }]}>
                    Trawsgrifiwr Byw
                  </Text>
                  <Text style={[styles.modalSubtitle, { color: theme.subText }]}>
                    Fersiwn 1.1.0 (Symudol / Mobile)
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => setShowAboutModal(false)}
                style={[styles.modalCloseButton, { backgroundColor: theme.toggleInactiveBg }]}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.7}
              >
                <Ionicons name="close" size={20} color={theme.headerText} />
              </TouchableOpacity>
            </View>

            {/* Modal Body */}
            <ScrollView
              style={styles.modalBody}
              contentContainerStyle={{ paddingBottom: 16 }}
              showsVerticalScrollIndicator={true}
            >
              {/* Description */}
              <View style={[styles.infoSection, { borderColor: theme.cardBorder }]}>
                <Text style={[styles.infoHeading, { color: theme.headerText }]}>
                  {t('Am y Rhaglen', 'About the App')}
                </Text>
                <Text style={[styles.infoText, { color: theme.transcriptText }]}>
                  {t(
                    'Ap Android ar gyfer adnabod lleferydd Cymraeg amser real a chyfieithu ar-ddyfais yn gyfan gwbl all-lein. Wedi’i adeiladu ar sail y prosiect bwrdd gwaith gwreiddiol "Trawsgrifiwr Byw" a ddatblygwyd gan Uned Technolegau Iaith Prifysgol Bangor.',
                    'An Android mobile application for real-time Welsh speech recognition and instant on-device translation, operating 100% offline. Adapted from the original desktop "Trawsgrifiwr Byw" project developed by the Language Technologies Unit at Bangor University.'
                  )}
                </Text>
              </View>

              {/* Credits & Attribution */}
              <View style={[styles.infoSection, { borderColor: theme.cardBorder }]}>
                <Text style={[styles.infoHeading, { color: theme.headerText }]}>
                  {t('Cydnabyddiaethau', 'Credits & Attribution')}
                </Text>

                <View style={styles.creditItem}>
                  <Text style={[styles.creditTitle, { color: theme.headerText }]}>
                    Sean Williams (S34NW)
                  </Text>
                  <Text style={[styles.creditDesc, { color: theme.subText }]}>
                    {t(
                      'Datblygwr a phorthwr y fersiwn symudol Android all-lein.',
                      'Developer and maintainer of the offline Android mobile application port.'
                    )}
                  </Text>
                </View>

                <View style={styles.creditItem}>
                  <Text style={[styles.creditTitle, { color: theme.headerText }]}>
                    Prifysgol Bangor University / Techiaith
                  </Text>
                  <Text style={[styles.creditDesc, { color: theme.subText }]}>
                    {t(
                      'Awduron y feddalwedd Trawsgrifiwr Byw wreiddiol a chrëwyr y modelau acwstig Kaldi Cymraeg (techiaith/kaldi-cy).',
                      'Authors of the original Trawsgrifiwr Byw desktop application and creators of the Welsh Kaldi acoustic models (techiaith/kaldi-cy).'
                    )}
                  </Text>
                </View>

                <View style={styles.creditItem}>
                  <Text style={[styles.creditTitle, { color: theme.headerText }]}>
                    Alpha Cephei Inc. (Vosk)
                  </Text>
                  <Text style={[styles.creditDesc, { color: theme.subText }]}>
                    {t(
                      'Peiriant adnabod lleferydd all-lein Vosk API (Trwydded Apache 2.0).',
                      'Vosk API offline speech recognition engine (Apache 2.0 License).'
                    )}
                  </Text>
                </View>

                <View style={styles.creditItem}>
                  <Text style={[styles.creditTitle, { color: theme.headerText }]}>
                    Google ML Kit / NLLB Techiaith
                  </Text>
                  <Text style={[styles.creditDesc, { color: theme.subText }]}>
                    {t(
                      'Modelau cyfieithu Cymraeg i’r Saesneg ar-ddyfais a gwasanaeth API Techiaith.',
                      'On-device Welsh-to-English translation models and Techiaith translation service.'
                    )}
                  </Text>
                </View>
              </View>

              {/* Open Source Licences */}
              <View style={[styles.infoSection, { borderColor: theme.cardBorder }]}>
                <Text style={[styles.infoHeading, { color: theme.headerText }]}>
                  {t('Trwyddedau Ffynhonnell Agored', 'Open Source Licences')}
                </Text>

                <View style={[styles.licenseBox, { backgroundColor: theme.transcriptBoxBg, borderColor: theme.cardBorder }]}>
                  <Text style={[styles.licenseHeader, { color: theme.headerText }]}>
                    Trawsgrifiwr Byw - MIT License
                  </Text>
                  <Text style={[styles.licenseLegal, { color: theme.subText }]}>
                    Copyright (c) 2026 Sean (S34NW) - Mobile Application{'\n'}
                    Copyright (c) 2025 Prifysgol Bangor University - Original Desktop Application{'\n\n'}
                    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:{'\n\n'}
                    The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.{'\n\n'}
                    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
                  </Text>
                </View>

                <View style={[styles.licenseBox, { backgroundColor: theme.transcriptBoxBg, borderColor: theme.cardBorder, marginTop: 10 }]}>
                  <Text style={[styles.licenseHeader, { color: theme.headerText }]}>
                    Vosk API - Apache License 2.0
                  </Text>
                  <Text style={[styles.licenseLegal, { color: theme.subText }]}>
                    Copyright (c) Alpha Cephei Inc.{'\n\n'}
                    Licensed under the Apache License, Version 2.0. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
                  </Text>
                </View>
              </View>

              {/* External Links */}
              <View style={styles.linksRow}>
                <TouchableOpacity
                  style={[styles.linkBtn, { backgroundColor: '#00843D' }]}
                  onPress={() => Linking.openURL('https://techiaith.cymru')}
                  activeOpacity={0.7}
                >
                  <Ionicons name="globe-outline" size={16} color="#FFFFFF" />
                  <Text style={styles.linkBtnText}>techiaith.cymru</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.linkBtn, { backgroundColor: '#24292E' }]}
                  onPress={() => Linking.openURL('https://github.com/techiaith/trawsgrifiwr-byw')}
                  activeOpacity={0.7}
                >
                  <Ionicons name="logo-github" size={16} color="#FFFFFF" />
                  <Text style={styles.linkBtnText}>GitHub Upstream</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>

            {/* Bottom Close Button */}
            <TouchableOpacity
              style={[styles.modalBottomCloseBtn, { backgroundColor: '#00843D' }]}
              onPress={() => setShowAboutModal(false)}
              activeOpacity={0.8}
            >
              <Text style={styles.modalBottomCloseText}>
                {t('Cau', 'Close')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    gap: 8,
  },
  logoButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerLogo: {
    width: 38,
    height: 38,
    borderRadius: 8,
  },
  headerButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  translateToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    height: 38,
    borderRadius: 19,
    gap: 5,
  },
  translateToggleText: {
    fontSize: 11,
    fontWeight: '800',
  },
  langBadge: {
    paddingHorizontal: 11,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  langBadgeText: {
    fontSize: 12,
    fontWeight: '800',
  },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  toast: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    alignSelf: 'center',
    marginBottom: 8,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  card: {
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    marginBottom: 12,
  },
  liveHeader: {
    backgroundColor: '#C8102E', // Welsh Red
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liveHeaderText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    gap: 5,
  },
  liveIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  liveBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  liveContent: {
    padding: 14,
    minHeight: 70,
    justifyContent: 'center',
  },
  liveText: {
    fontWeight: '700',
  },
  liveTranslationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  liveTranslationTag: {
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  liveTranslationText: {
    fontWeight: '600',
    fontStyle: 'italic',
    flex: 1,
  },
  placeholderText: {
    fontStyle: 'italic',
  },
  transcriptsCard: {
    flex: 1,
    marginBottom: 12,
  },
  completedHeader: {
    backgroundColor: '#00843D', // Welsh Green
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 8,
  },
  headerTitleGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    overflow: 'hidden',
  },
  completedHeaderText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  countBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
    marginLeft: 2,
  },
  countBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  headerRightControls: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  saveToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 32,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  saveToggleBtnActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
  },
  saveToggleBtnInactive: {
    backgroundColor: 'rgba(0, 0, 0, 0.28)',
  },
  saveToggleBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  fontControls: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  fontButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    width: 36,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fontButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
  },
  transcriptItemCard: {
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  transcriptLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  timeBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    marginTop: 2,
  },
  timeText: {
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  transcriptText: {
    flex: 1,
    fontWeight: '700',
    lineHeight: 22,
  },
  translatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    marginLeft: 32,
  },
  translatingText: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  translationCard: {
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: 8,
    marginLeft: 28,
  },
  translationHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 2,
  },
  translationLangTag: {
    fontSize: 10,
    fontWeight: '800',
  },
  translationText: {
    lineHeight: 20,
    fontWeight: '600',
  },
  transcriptActions: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 10,
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 6,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 5,
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  clearBtn: {
    marginLeft: 'auto',
  },
  footerControls: {
    paddingTop: 8,
    paddingBottom: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonWrapper: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: 80,
    height: 80,
  },
  micPulseRing: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#C8102E',
    opacity: 0.22,
  },
  micButton: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 6,
    elevation: 6,
  },
  micButtonReady: {
    backgroundColor: '#00843D', // Welsh Green
  },
  micButtonRecording: {
    backgroundColor: '#C8102E', // Welsh Red
  },
  micButtonDisabled: {
    backgroundColor: '#64748B',
    elevation: 1,
    shadowOpacity: 0.1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxHeight: '85%',
    borderRadius: 20,
    borderWidth: 1,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(150, 150, 150, 0.2)',
  },
  aboutHeaderLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  aboutModalLogo: {
    width: 44,
    height: 44,
    borderRadius: 10,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
  },
  modalSubtitle: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  modalCloseButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
  },
  modalBody: {
    flexShrink: 1,
  },
  infoSection: {
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  infoHeading: {
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 6,
  },
  infoText: {
    fontSize: 13,
    lineHeight: 20,
  },
  creditItem: {
    marginBottom: 10,
  },
  creditTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  creditDesc: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 2,
  },
  licenseBox: {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  licenseHeader: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  licenseLegal: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'monospace',
  },
  linksRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
    marginBottom: 10,
  },
  linkBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  linkBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  modalBottomCloseBtn: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  modalBottomCloseText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  emptySessionBanner: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  emptySessionBannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  emptySessionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  emptySessionBannerTitle: {
    fontSize: 13,
    fontWeight: '800',
  },
  emptySessionDate: {
    fontSize: 11,
    fontWeight: '600',
  },
  emptySessionPreview: {
    fontSize: 13,
    fontStyle: 'italic',
    marginBottom: 10,
    lineHeight: 18,
  },
  emptySessionActions: {
    flexDirection: 'row',
    gap: 8,
  },
  emptySessionPrimaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  emptySessionPrimaryBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  emptySessionSecondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  emptySessionSecondaryBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  sessionsModalActionBar: {
    marginBottom: 12,
  },
  newSessionPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    borderRadius: 10,
  },
  newSessionPrimaryBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  emptySessionsModalBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
    gap: 10,
  },
  emptySessionsModalText: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  sessionCard: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  sessionCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  sessionCardMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  sessionCardDate: {
    fontSize: 11,
    fontWeight: '600',
  },
  saveToggleBtnActiveSolid: {
    backgroundColor: '#00843D',
  },
  sessionsDropdownContainer: {
    borderBottomWidth: 1,
    padding: 12,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
    zIndex: 10,
  },
  sessionsDropdownHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  sessionsDropdownTitle: {
    fontSize: 14,
    fontWeight: '800',
  },
  sessionsDropdownSubtitle: {
    fontSize: 11,
    marginTop: 1,
    fontWeight: '500',
  },
  dropdownNewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  dropdownNewBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  sessionsDropdownScroll: {
    maxHeight: 220,
  },
  emptyDropdownStateBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    paddingHorizontal: 16,
    gap: 6,
  },
  emptyDropdownStateText: {
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  dropdownSessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
  },
  dropdownSessionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  dropdownSessionDate: {
    fontSize: 11,
    fontWeight: '600',
  },
  dropdownSessionTitle: {
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  dropdownSessionTranslation: {
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 2,
  },
  dropdownRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 6,
  },
  dropdownDeleteBtn: {
    width: 32,
    height: 32,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropdownFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    paddingTop: 8,
    marginTop: 4,
  },
  dropdownClearAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  dropdownClearAllText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '700',
  },
  dropdownCloseBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  dropdownCloseText: {
    fontSize: 12,
    fontWeight: '700',
  },
  sessionCountPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  sessionCountPillText: {
    fontSize: 10,
    fontWeight: '700',
  },
  activeSessionBadge: {
    backgroundColor: '#10B981',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  activeSessionBadgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
  },
  sessionCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
    marginBottom: 4,
  },
  sessionCardTranslationPreview: {
    fontSize: 12,
    fontStyle: 'italic',
    marginBottom: 8,
  },
  sessionCardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  sessionResumeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 8,
  },
  sessionResumeBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  sessionDeleteBtn: {
    width: 36,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionsModalFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
  },
  deleteAllSessionsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  deleteAllSessionsText: {
    color: '#EF4444',
    fontSize: 13,
    fontWeight: '700',
  },
  settingsItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 12,
  },
  settingsLabelGroup: {
    flex: 1,
  },
  settingsLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  settingsItemTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  settingsItemDesc: {
    fontSize: 12,
    marginTop: 2,
    lineHeight: 17,
  },
  settingsSectionBox: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 14,
  },
  settingsFontSizeBadge: {
    fontSize: 11,
    fontWeight: '800',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 'auto',
  },
  settingsFontControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  settingsFontBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 8,
    gap: 4,
    minWidth: 62,
  },
  settingsFontBtnText: {
    fontSize: 13,
    fontWeight: '800',
  },
  settingsBtnDisabled: {
    opacity: 0.4,
  },
  settingsFontPreviewBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    minHeight: 36,
  },
  settingsFontPreviewText: {
    fontWeight: '700',
    textAlign: 'center',
  },
  settingsLangPillsRow: {
    gap: 8,
  },
  settingsLangPill: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsLangPillText: {
    fontSize: 13,
    fontWeight: '700',
  },
  settingsAboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 14,
  },
});
