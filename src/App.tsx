import { Fragment, useEffect, useMemo, useState, type PointerEvent, type ReactNode } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  LayoutDashboard,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  Timer,
  Trophy,
  X,
} from 'lucide-react';
import { Button as ShadButton } from '@/components/ui/button';
import { Input as ShadInput } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Select as ShadSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/sonner';
import {
  Tooltip as ShadTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Textarea as ShadTextarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  FormControl,
  GlobalStyles,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  TextField,
  ThemeProvider,
  Tooltip,
  Typography,
  createTheme,
} from '@mui/material';

type Language = 'python' | 'cpp';

type RunResult = {
  ok: boolean;
  stage: 'compile' | 'run';
  output: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
};

type Notice = {
  severity: 'info' | 'error' | 'success' | 'warning';
  message: string;
};

type AiMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type LcProblem = {
  id: string;
  frontendId?: string;
  title: string;
  slug?: string;
  difficulty: string;
  statement: string;
  content?: string;
  url?: string;
  acceptanceRate?: string | number | null;
  totalAccepted?: string | number | null;
  totalSubmission?: string | number | null;
  codeDefinition?: Array<{ value?: string; text?: string; defaultCode?: string }>;
  sampleTestCase?: string;
  metaData?: unknown;
  envInfo?: unknown;
  similarQuestions?: unknown;
  category?: string | null;
  isPaidOnly?: boolean;
  language?: string | null;
  solved: boolean;
  attempts: number;
  timeSpentSeconds: number;
  tags: Array<string | { name?: string; slug?: string }>;
  raw?: Record<string, unknown>;
};

type LcStats = {
  totalProblems: number;
  solvedProblems: number;
  attemptedProblems: number;
  totalTimeSeconds: number;
  byDifficulty: Record<string, number>;
};

const examples: Record<Language, string> = {
  python: `name = input().strip() or "locom"
print(f"Hello, {name}!")
print("Python is ready.")`,
  cpp: `#include <iostream>
#include <string>

int main() {
    std::string name;
    std::getline(std::cin, name);
    if (name.empty()) name = "locom";

    std::cout << "Hello, " << name << "!\\n";
    std::cout << "C++ is ready.\\n";
    return 0;
}`,
};

type MarkdownBlock =
  | { type: 'code'; language: string; code: string }
  | { type: 'heading'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'paragraph'; text: string };

const parseMarkdown = (source: string): MarkdownBlock[] => {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }

    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      flushParagraph();
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      flushParagraph();
      blocks.push({ type: 'heading', text: trimmed.replace(/^#{1,6}\s+/, '') });
      continue;
    }

    if (/^(\d+\.\s+|[-*]\s+)/.test(trimmed)) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length && /^(\d+\.\s+|[-*]\s+)/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^(\d+\.\s+|[-*]\s+)/, ''));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: 'list', items });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return blocks;
};

const renderInlineMarkdown = (text: string): ReactNode[] => {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={index} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">
          {part.slice(1, -1)}
        </code>
      );
    }

    return <Fragment key={index}>{part}</Fragment>;
  });
};

const formatTimer = (totalSeconds: number) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedMinutes = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const paddedSeconds = String(seconds).padStart(2, '0');

  return hours > 0 ? `${hours}:${paddedMinutes}:${paddedSeconds}` : `${paddedMinutes}:${paddedSeconds}`;
};

const formatDuration = (totalSeconds: number) => {
  if (!totalSeconds) {
    return '0m';
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours === 0) {
    return `${Math.max(1, minutes)}m`;
  }

  return `${hours}h ${minutes}m`;
};

const getProblemStarterCode = (problem: LcProblem, language: Language) => {
  const definition = getProblemCodeDefinition(problem, language);
  if (definition?.defaultCode) {
    return definition.defaultCode;
  }

  const raw = problem.raw ?? {};
  const keys =
    language === 'python'
      ? ['python_starter', 'starter_python', 'python_code', 'starter_code', 'template', 'boilerplate']
      : ['cpp_starter', 'starter_cpp', 'cpp_code', 'starter_code', 'template', 'boilerplate'];

  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return examples[language];
};

const codeDefinitionMatchesLanguage = (
  definition: { value?: string; text?: string; defaultCode?: string },
  language: Language,
) => {
  const value = `${definition.value ?? ''} ${definition.text ?? ''}`.toLowerCase();
  return language === 'cpp'
    ? value.includes('cpp') || value.includes('c++')
    : value === 'python' || value.includes('python3') || value.includes('python');
};

const getProblemCodeDefinition = (problem: LcProblem, language: Language) =>
  problem.codeDefinition?.find((definition) => codeDefinitionMatchesLanguage(definition, language));

const chooseProblemLanguage = (problem?: LcProblem, currentLanguage: Language = 'python'): Language => {
  if (!problem?.codeDefinition?.length) {
    return problem?.language === 'cpp' || problem?.language === 'python' ? problem.language : currentLanguage;
  }

  if (getProblemCodeDefinition(problem, currentLanguage)) {
    return currentLanguage;
  }

  if (getProblemCodeDefinition(problem, 'python')) {
    return 'python';
  }

  if (getProblemCodeDefinition(problem, 'cpp')) {
    return 'cpp';
  }

  return currentLanguage;
};

const tagLabel = (tag: string | { name?: string; slug?: string }) =>
  typeof tag === 'string' ? tag : tag.name || tag.slug || 'Topic';

const formatAcceptanceRate = (value: LcProblem['acceptanceRate']) => {
  if (value === null || value === undefined || value === '') {
    return 'n/a';
  }

  if (typeof value === 'number') {
    return value <= 1 ? `${Math.round(value * 1000) / 10}%` : `${Math.round(value * 10) / 10}%`;
  }

  return value;
};

const truncatePlainText = (html: string, maxLength = 180) => {
  const plain = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

  return plain.length > maxLength ? `${plain.slice(0, maxLength)}...` : plain;
};

function MarkdownMessage({ content }: { content: string }) {
  const [copiedCode, setCopiedCode] = useState<number | null>(null);
  const blocks = useMemo(() => parseMarkdown(content), [content]);

  const copyCode = async (code: string, index: number) => {
    await navigator.clipboard.writeText(code);
    setCopiedCode(index);
    window.setTimeout(() => setCopiedCode(null), 1200);
  };

  return (
    <div className="space-y-3 text-sm leading-6">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          return (
            <div key={index} className="text-sm font-semibold text-foreground">
              {renderInlineMarkdown(block.text)}
            </div>
          );
        }

        if (block.type === 'list') {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }

        if (block.type === 'code') {
          return (
            <div key={index} className="overflow-hidden rounded-md border border-border bg-muted/50">
              <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                <span className="font-mono text-xs text-muted-foreground">
                  {block.language || 'code'}
                </span>
                <ShadButton
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy code"
                  onClick={() => void copyCode(block.code, index)}
                >
                  {copiedCode === index ? <Check size={13} /> : <Copy size={13} />}
                </ShadButton>
              </div>
              <pre className="max-h-80 overflow-auto p-3 text-left font-mono text-xs leading-5">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

export default function App() {
  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const [language, setLanguage] = useState<Language>('python');
  const [code, setCode] = useState(examples.python);
  const [result, setResult] = useState<RunResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [leftPaneWidth, setLeftPaneWidth] = useState(54);
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [isShadcnTheme, setIsShadcnTheme] = useState(false);
  const [aiSidebarWidth, setAiSidebarWidth] = useState(420);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [lcStats, setLcStats] = useState<LcStats>({
    totalProblems: 0,
    solvedProblems: 0,
    attemptedProblems: 0,
    totalTimeSeconds: 0,
    byDifficulty: {},
  });
  const [lcProblems, setLcProblems] = useState<LcProblem[]>([]);
  const [lcError, setLcError] = useState('');
  const [isLcLoading, setIsLcLoading] = useState(false);
  const [problemSearch, setProblemSearch] = useState('');
  const [problemDetails, setProblemDetails] = useState<Record<string, LcProblem>>({});
  const [isProblemDetailLoading, setIsProblemDetailLoading] = useState(false);
  const [problemToShow, setProblemToShow] = useState<LcProblem | null>(null);
  const [ideProblem, setIdeProblem] = useState<LcProblem | null>(null);
  const [isAntiCheatEnabled, setIsAntiCheatEnabled] = useState(false);
  const [isProctorStarting, setIsProctorStarting] = useState(false);
  const [isProctorActive, setIsProctorActive] = useState(false);
  const [proctorStreams, setProctorStreams] = useState<MediaStream[]>([]);
  const isCompilerDark = isDarkMode;

  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: isCompilerDark ? 'dark' : 'light',
        },
      }),
    [isCompilerDark],
  );

  useEffect(() => {
    const syncPath = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', syncPath);
    return () => window.removeEventListener('popstate', syncPath);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isCompilerDark);
  }, [isCompilerDark]);

  useEffect(() => {
    if (!isTimerRunning) {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      setTimerSeconds((current) => current + 1);
    }, 1000);

    return () => window.clearInterval(timerId);
  }, [isTimerRunning]);

  const handleLanguageChange = (nextLanguage: Language) => {
    setLanguage(nextLanguage);
    setCode(ideProblem ? getProblemStarterCode(ideProblem, nextLanguage) : examples[nextLanguage]);
    setResult(null);
  };

  const runCode = async () => {
    if (currentPath === '/ide' && isAntiCheatEnabled && !isProctorActive) {
      showNotice({
        severity: 'warning',
        message: 'Open the IDE from the dashboard to start the anti-cheat session first.',
      });
      navigateTo('/');
      return;
    }

    setIsRunning(true);
    setResult(null);

    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ language, code, input: '\n' }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message ?? 'Run failed.');
      }

      setResult(data);
      if (!data.ok) {
        showNotice({
          severity: data.timedOut ? 'warning' : 'error',
          message: data.stage === 'compile' ? 'Compilation failed.' : `Exited with code ${data.exitCode}.`,
        });
      } else {
        showNotice({
          severity: 'success',
          message: `Success - ${data.durationMs} ms`,
        });
      }

      if (data.ok && !data.output) {
        showNotice({
          severity: 'info',
          message: `Success - ${data.durationMs} ms - No output`,
        });
      }
    } catch (caughtError) {
      showNotice({
        severity: 'error',
        message: caughtError instanceof Error ? caughtError.message : 'Run failed.',
      });
    } finally {
      setIsRunning(false);
    }
  };

  const outputText = result?.output ?? '';

  const languageExtensions = language === 'python' ? [python()] : [cpp()];
  const editorExtensions = isCompilerDark ? [...languageExtensions, oneDark] : languageExtensions;
  const terminalBackground = isCompilerDark ? '#0d1117' : '#ffffff';
  const terminalText = isCompilerDark ? '#e6edf3' : '#1f2328';
  const shadcnStyles = isShadcnTheme
    ? {
        '--locom-bg': 'var(--background)',
        '--locom-card': 'var(--card)',
        '--locom-border': 'var(--border)',
        '--locom-ring': 'var(--ring)',
      }
    : {};

  const navigateTo = (path: string) => {
    window.history.pushState(null, '', path);
    setCurrentPath(path);
  };

  const useShadcnTheme = () => setIsShadcnTheme(true);
  const useMaterialTheme = () => setIsShadcnTheme(false);

  const startHorizontalResize = (event: PointerEvent<HTMLDivElement>) => {
    const container = event.currentTarget.parentElement;
    if (!container) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = container.getBoundingClientRect();

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setLeftPaneWidth(Math.min(75, Math.max(25, nextWidth)));
    };

    const stopResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
  };

  const startAiSidebarResize = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const maxWidth = Math.min(860, window.innerWidth - 24);
      const nextWidth = window.innerWidth - moveEvent.clientX;
      setAiSidebarWidth(Math.min(maxWidth, Math.max(320, nextWidth)));
    };

    const stopResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
  };

  const controlButtonSx = {
    width: 48,
    minWidth: 48,
    height: 40,
    borderRadius: isShadcnTheme ? 1.5 : undefined,
    textTransform: isShadcnTheme ? 'none' : undefined,
    boxShadow: isShadcnTheme ? 'none' : undefined,
  };

  const showNotice = (nextNotice: Notice) => {
    if (!isShadcnTheme) {
      setNotice(nextNotice);
      return;
    }

    toast[nextNotice.severity](nextNotice.message);
  };

  const loadLcDashboard = async () => {
    setIsLcLoading(true);
    setLcError('');

    try {
      const [dashboardResponse, problemsResponse] = await Promise.all([
        fetch('/api/lc/dashboard'),
        fetch('/api/lc/problems'),
      ]);
      const dashboardData = await dashboardResponse.json();
      const problemsData = await problemsResponse.json();

      if (!dashboardResponse.ok) {
        throw new Error(dashboardData.message ?? 'Unable to load dashboard.');
      }

      if (!problemsResponse.ok) {
        throw new Error(problemsData.message ?? 'Unable to load LC problems.');
      }

      setLcStats(dashboardData.stats);
      const nextProblems = problemsData.problems ?? [];
      setLcProblems(nextProblems);
    } catch (caughtError) {
      setLcError(caughtError instanceof Error ? caughtError.message : 'Unable to load LC dashboard.');
    } finally {
      setIsLcLoading(false);
    }
  };

  useEffect(() => {
    void loadLcDashboard();
  }, []);

  useEffect(() => {
    if (currentPath === '/ide' && isAntiCheatEnabled && !isProctorActive) {
      navigateTo('/');
    }
  }, [currentPath, isAntiCheatEnabled, isProctorActive]);

  const stopProctorStreams = (streams: MediaStream[]) => {
    streams.forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });
  };

  const logProctorEvent = (reason: string) => {
    void fetch('/api/lc/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventType: 'anti_cheat_terminated',
        reason,
        language,
      }),
    }).catch(() => undefined);
  };

  const resetCompilerSession = () => {
    setCode(examples[language]);
    setResult(null);
    setIdeProblem(null);
    setAiMessages([]);
    setAiQuestion('');
    setIsAiOpen(false);
    setTimerSeconds(0);
    setIsTimerRunning(false);
  };

  const terminateProctorSession = (reason: string) => {
    stopProctorStreams(proctorStreams);
    setProctorStreams([]);
    setIsProctorActive(false);
    resetCompilerSession();
    logProctorEvent(reason);
    showNotice({
      severity: 'error',
      message: `${reason} Session reset.`,
    });
    navigateTo('/');
  };

  useEffect(() => {
    if (!isProctorActive) {
      return undefined;
    }

    const terminateFromEvent = (reason: string) => (event: Event) => {
      event.preventDefault();
      terminateProctorSession(reason);
    };
    const blockedClipboard = terminateFromEvent('Clipboard and context-menu actions are blocked in anti-cheat mode.');
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        terminateProctorSession('The browser tab was hidden during anti-cheat mode.');
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && ['c', 'v', 'x'].includes(key)) {
        event.preventDefault();
        terminateProctorSession('Cut, copy, and paste shortcuts are blocked in anti-cheat mode.');
      }

      if (key === 'printscreen') {
        event.preventDefault();
        terminateProctorSession('Screenshot key detected during anti-cheat mode.');
      }
    };
    const handleTrackEnded = () => terminateProctorSession('Screen, camera, or microphone sharing stopped.');

    document.addEventListener('copy', blockedClipboard, true);
    document.addEventListener('cut', blockedClipboard, true);
    document.addEventListener('paste', blockedClipboard, true);
    document.addEventListener('contextmenu', blockedClipboard, true);
    document.addEventListener('drop', blockedClipboard, true);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('keydown', handleKeyDown, true);
    proctorStreams.forEach((stream) => {
      stream.getTracks().forEach((track) => track.addEventListener('ended', handleTrackEnded));
    });

    return () => {
      document.removeEventListener('copy', blockedClipboard, true);
      document.removeEventListener('cut', blockedClipboard, true);
      document.removeEventListener('paste', blockedClipboard, true);
      document.removeEventListener('contextmenu', blockedClipboard, true);
      document.removeEventListener('drop', blockedClipboard, true);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('keydown', handleKeyDown, true);
      proctorStreams.forEach((stream) => {
        stream.getTracks().forEach((track) => track.removeEventListener('ended', handleTrackEnded));
      });
    };
  }, [isProctorActive, proctorStreams, language]);

  const startProctoredSession = async (problem?: LcProblem) => {
    if (!navigator.mediaDevices?.getDisplayMedia || !navigator.mediaDevices?.getUserMedia) {
      showNotice({
        severity: 'error',
        message: 'This browser does not support screen, camera, and microphone sharing.',
      });
      return;
    }

    setIsProctorStarting(true);

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      const nextStreams = [screenStream, mediaStream];
      const nextLanguage = chooseProblemLanguage(problem, language);

      if (document.fullscreenEnabled && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen().catch(() => undefined);
      }

      setLanguage(nextLanguage);
      setCode(problem ? getProblemStarterCode(problem, nextLanguage) : examples[nextLanguage]);
      setResult(null);
      setIdeProblem(problem ?? null);
      setProctorStreams(nextStreams);
      setIsProctorActive(true);
      setIsTimerRunning(true);
      navigateTo('/ide');
      showNotice({
        severity: 'success',
        message: 'Anti-cheat session started.',
      });
    } catch (caughtError) {
      showNotice({
        severity: 'error',
        message:
          caughtError instanceof Error
            ? caughtError.message
            : 'Screen, camera, and microphone permissions are required.',
      });
    } finally {
      setIsProctorStarting(false);
    }
  };

  const openIdeSession = async (problem?: LcProblem) => {
    const detailedProblem = problem ? await loadProblemDetail(problem) : undefined;
    if (isAntiCheatEnabled) {
      await startProctoredSession(detailedProblem);
      return;
    }

    const nextLanguage = chooseProblemLanguage(detailedProblem, language);

    setLanguage(nextLanguage);
    setCode(detailedProblem ? getProblemStarterCode(detailedProblem, nextLanguage) : examples[nextLanguage]);
    setResult(null);
    setIdeProblem(detailedProblem ?? null);
    setIsTimerRunning(true);
    navigateTo('/ide');
  };

  const problemCacheKey = (problem: LcProblem) => String(problem.slug || problem.frontendId || problem.id);

  const loadProblemDetail = async (problem: LcProblem) => {
    const key = problemCacheKey(problem);
    if (problemDetails[key]?.content || problemDetails[key]?.codeDefinition?.length) {
      return problemDetails[key];
    }

    setIsProblemDetailLoading(true);
    try {
      const response = await fetch(`/api/lc/problems/${encodeURIComponent(key)}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message ?? 'Unable to load problem details.');
      }

      const detailedProblem = data.problem as LcProblem;
      setProblemDetails((current) => ({ ...current, [key]: detailedProblem }));
      return detailedProblem;
    } catch (caughtError) {
      showNotice({
        severity: 'warning',
        message: caughtError instanceof Error ? caughtError.message : 'Unable to load problem details.',
      });
      return problem;
    } finally {
      setIsProblemDetailLoading(false);
    }
  };

  const showProblem = async (problem: LcProblem) => {
    const detailedProblem = await loadProblemDetail(problem);
    setProblemToShow(detailedProblem);
    navigateTo(`/problem/${detailedProblem.slug || detailedProblem.id}`);
  };

  const askAi = async () => {
    const question = aiQuestion.trim();
    if (!question) {
      return;
    }

    const nextMessages: AiMessage[] = [...aiMessages, { role: 'user', content: question }];
    setAiMessages(nextMessages);
    setAiQuestion('');
    setIsAiLoading(true);

    try {
      const response = await fetch('/api/ai', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          question,
          language,
          code,
          output: outputText,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message ?? 'AI request failed.');
      }

      setAiMessages([...nextMessages, { role: 'assistant', content: data.answer }]);
    } catch (caughtError) {
      setAiMessages([
        ...nextMessages,
        {
          role: 'assistant',
          content: caughtError instanceof Error ? caughtError.message : 'AI request failed.',
        },
      ]);
    } finally {
      setIsAiLoading(false);
    }
  };

  const problemPathMatch = currentPath.match(/^\/problem\/(.+)$/);
  if (problemPathMatch) {
    const problemId = decodeURIComponent(problemPathMatch[1]);
    const currentProblem =
      problemToShow ??
      lcProblems.find((problem) => problem.slug === problemId || problem.id === problemId || problem.frontendId === problemId) ??
      null;

    return (
      <ThemeProvider theme={theme}>
        <TooltipProvider>
          <CssBaseline />
          <GlobalStyles
            styles={{
              '*': {
                scrollbarWidth: 'thin',
                scrollbarColor: isCompilerDark || isShadcnTheme ? '#6b7280 transparent' : '#9ca3af transparent',
              },
              '*::-webkit-scrollbar': {
                width: 7,
                height: 7,
              },
              '*::-webkit-scrollbar-track': {
                background: 'transparent',
              },
              '*::-webkit-scrollbar-thumb': {
                backgroundColor: isCompilerDark || isShadcnTheme ? '#6b7280' : '#9ca3af',
                borderRadius: 999,
              },
              '*::-webkit-scrollbar-thumb:hover': {
                backgroundColor: isCompilerDark || isShadcnTheme ? '#9ca3af' : '#6b7280',
              },
              '*::-webkit-scrollbar-corner': {
                background: 'transparent',
              },
              '*::-webkit-scrollbar-button': {
                display: 'none',
                width: 0,
                height: 0,
              },
              '.locom-problem-content': {
                fontSize: 15,
                lineHeight: 1.75,
              },
              '.locom-problem-content p': {
                margin: '0 0 12px',
              },
              '.locom-problem-content pre': {
                margin: '12px 0',
                padding: '12px 14px',
                overflow: 'auto',
                borderRadius: 8,
                backgroundColor: isCompilerDark ? '#0d1117' : '#f6f8fa',
                border: `1px solid ${isCompilerDark ? '#30363d' : '#d8dee4'}`,
                fontFamily:
                  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
                fontSize: 13,
                whiteSpace: 'pre-wrap',
              },
              '.locom-problem-content code': {
                padding: '2px 5px',
                borderRadius: 5,
                backgroundColor: isCompilerDark ? '#161b22' : '#eef1f4',
                fontFamily:
                  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
                fontSize: '0.92em',
              },
              '.locom-problem-content ul, .locom-problem-content ol': {
                paddingLeft: 24,
                margin: '8px 0 12px',
              },
              '.locom-problem-content li': {
                marginBottom: 6,
              },
            }}
          />
          <Box
            sx={{
              minHeight: '100vh',
              bgcolor: isShadcnTheme ? 'var(--locom-bg)' : 'background.default',
              color: isShadcnTheme ? 'var(--foreground)' : 'text.primary',
              overflow: 'auto',
              ...shadcnStyles,
            }}
          >
            <Stack
              direction="row"
              sx={{
                alignItems: 'center',
                justifyContent: 'space-between',
                height: 57,
                borderBottom: 1,
                borderColor: isShadcnTheme ? 'var(--locom-border)' : 'divider',
                px: 3,
              }}
            >
              <Typography
                sx={{
                  fontFamily:
                    '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
                  fontWeight: 800,
                }}
              >
                {'</locom>'}
              </Typography>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                <Button variant="outlined" onClick={() => navigateTo('/')}>
                  Problems
                </Button>
                {currentProblem && (
                  <Button
                    variant="contained"
                    startIcon={isProctorStarting ? <CircularProgress size={16} /> : <Play size={16} />}
                    onClick={() => void openIdeSession(currentProblem)}
                    disabled={isProctorStarting}
                  >
                    Solve Problem
                  </Button>
                )}
              </Stack>
            </Stack>

            <Box sx={{ maxWidth: 1040, mx: 'auto', p: { xs: 2, md: 3 } }}>
              {!currentProblem ? (
                <Paper variant="outlined" sx={{ p: 3, borderRadius: isShadcnTheme ? 2 : 1 }}>
                  <Typography sx={{ fontWeight: 800, mb: 1 }}>Problem not loaded yet</Typography>
                  <Typography color="text.secondary" sx={{ mb: 2 }}>
                    Go back to the problem list and choose a problem.
                  </Typography>
                  <Button variant="contained" onClick={() => navigateTo('/')}>
                    Back to Problems
                  </Button>
                </Paper>
              ) : (
                <Paper
                  variant="outlined"
                  sx={{
                    borderRadius: isShadcnTheme ? 2 : 1,
                    overflow: 'hidden',
                    bgcolor: isShadcnTheme ? 'var(--locom-card)' : 'background.paper',
                  }}
                >
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={2}
                    sx={{
                      alignItems: { xs: 'stretch', md: 'center' },
                      justifyContent: 'space-between',
                      p: 2.5,
                      borderBottom: 1,
                      borderColor: isShadcnTheme ? 'var(--locom-border)' : 'divider',
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                        <Typography variant="h4" sx={{ fontWeight: 900 }} noWrap>
                          {currentProblem.frontendId ? `${currentProblem.frontendId}. ` : ''}
                          {currentProblem.title}
                        </Typography>
                        <Typography
                          variant="caption"
                          color={
                            currentProblem.difficulty === 'Easy'
                              ? 'success.main'
                              : currentProblem.difficulty === 'Hard'
                                ? 'error.main'
                                : 'warning.main'
                          }
                        >
                          {currentProblem.difficulty}
                        </Typography>
                      </Stack>
                      <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap' }}>
                        <Typography variant="caption" color="text.secondary">
                          Acceptance {formatAcceptanceRate(currentProblem.acceptanceRate)}
                        </Typography>
                        {currentProblem.totalAccepted && (
                          <Typography variant="caption" color="text.secondary">
                            Accepted {currentProblem.totalAccepted}
                          </Typography>
                        )}
                        {currentProblem.totalSubmission && (
                          <Typography variant="caption" color="text.secondary">
                            Submissions {currentProblem.totalSubmission}
                          </Typography>
                        )}
                      </Stack>
                    </Box>
                    <Button
                      variant="contained"
                      startIcon={isProctorStarting ? <CircularProgress size={16} /> : <Play size={16} />}
                      onClick={() => void openIdeSession(currentProblem)}
                      disabled={isProctorStarting}
                    >
                      Solve Problem
                    </Button>
                  </Stack>

                  <Box sx={{ p: { xs: 2, md: 3 } }}>
                    <Stack spacing={2.25}>
                      <Box
                        className="locom-problem-content"
                        dangerouslySetInnerHTML={{
                          __html:
                            currentProblem.content ||
                            currentProblem.statement ||
                            `<p>${truncatePlainText(currentProblem.title)}</p>`,
                        }}
                      />

                      {currentProblem.tags.length > 0 && (
                        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                          {currentProblem.tags.slice(0, 12).map((tag) => (
                            <Box
                              key={tagLabel(tag)}
                              sx={{ px: 1, py: 0.35, borderRadius: 999, bgcolor: 'action.hover', fontSize: 12 }}
                            >
                              {tagLabel(tag)}
                            </Box>
                          ))}
                        </Stack>
                      )}

                      {currentProblem.sampleTestCase && (
                        <Box>
                          <Typography sx={{ fontWeight: 800, mb: 1 }}>Sample Test Case</Typography>
                          <Box
                            component="pre"
                            sx={{
                              m: 0,
                              p: 1.5,
                              overflow: 'auto',
                              borderRadius: 1,
                              bgcolor: isCompilerDark ? '#0d1117' : '#f6f8fa',
                              fontFamily:
                                '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
                              fontSize: 13,
                            }}
                          >
                            {currentProblem.sampleTestCase}
                          </Box>
                        </Box>
                      )}

                      {currentProblem.codeDefinition && currentProblem.codeDefinition.length > 0 && (
                        <Box>
                          <Typography sx={{ fontWeight: 800, mb: 1 }}>Code Stubs</Typography>
                          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                            {currentProblem.codeDefinition.slice(0, 8).map((definition) => (
                              <Box
                                key={definition.value || definition.text}
                                sx={{
                                  px: 1,
                                  py: 0.35,
                                  borderRadius: 1,
                                  border: 1,
                                  borderColor: isShadcnTheme ? 'var(--locom-border)' : 'divider',
                                  fontSize: 12,
                                }}
                              >
                                {definition.text || definition.value}
                              </Box>
                            ))}
                          </Stack>
                        </Box>
                      )}
                    </Stack>
                  </Box>
                </Paper>
              )}
            </Box>
          </Box>
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  if (currentPath === '/') {
    const normalizedProblemSearch = problemSearch.trim().toLowerCase();
    const visibleProblems = normalizedProblemSearch
      ? lcProblems.filter((problem) =>
          [
            problem.frontendId,
            problem.id,
            problem.title,
            problem.slug,
            problem.difficulty,
            ...problem.tags.map(tagLabel),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(normalizedProblemSearch),
        )
      : lcProblems;
    const statCards = [
      {
        label: 'Total problems',
        value: lcStats.totalProblems,
        icon: <LayoutDashboard size={18} />,
      },
      {
        label: 'Solved',
        value: lcStats.solvedProblems,
        icon: <Trophy size={18} />,
      },
      {
        label: 'Attempted',
        value: lcStats.attemptedProblems,
        icon: <ShieldCheck size={18} />,
      },
      {
        label: 'Time spent',
        value: formatDuration(lcStats.totalTimeSeconds),
        icon: <Clock size={18} />,
      },
    ];

    return (
      <ThemeProvider theme={theme}>
        <TooltipProvider>
          <CssBaseline />
          <GlobalStyles
            styles={{
              '.locom-problem-content': {
                fontSize: 15,
                lineHeight: 1.75,
              },
              '.locom-problem-content p': {
                margin: '0 0 12px',
              },
              '.locom-problem-content pre': {
                margin: '12px 0',
                padding: '12px 14px',
                overflow: 'auto',
                borderRadius: 8,
                backgroundColor: isCompilerDark ? '#0d1117' : '#f6f8fa',
                border: `1px solid ${isCompilerDark ? '#30363d' : '#d8dee4'}`,
                fontFamily:
                  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
                fontSize: 13,
                whiteSpace: 'pre-wrap',
              },
              '.locom-problem-content code': {
                padding: '2px 5px',
                borderRadius: 5,
                backgroundColor: isCompilerDark ? '#161b22' : '#eef1f4',
                fontFamily:
                  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
                fontSize: '0.92em',
              },
              '.locom-problem-content ul, .locom-problem-content ol': {
                paddingLeft: 24,
                margin: '8px 0 12px',
              },
              '.locom-problem-content li': {
                marginBottom: 6,
              },
            }}
          />
          <Box
            sx={{
              minHeight: '100vh',
              bgcolor: isShadcnTheme ? 'var(--locom-bg)' : 'background.default',
              color: isShadcnTheme ? 'var(--foreground)' : 'text.primary',
              overflow: 'auto',
              ...shadcnStyles,
            }}
          >
            <Stack
              direction="row"
              sx={{
                alignItems: 'center',
                justifyContent: 'space-between',
                height: 57,
                borderBottom: 1,
                borderColor: isShadcnTheme ? 'var(--locom-border)' : 'divider',
                px: 3,
              }}
            >
              <Typography
                sx={{
                  fontFamily:
                    '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
                  fontWeight: 800,
                }}
              >
                {'</locom>'}
              </Typography>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                {isShadcnTheme ? (
                  <ShadButton variant="outline" size="icon" onClick={() => navigateTo('/settings')}>
                    <Settings size={16} />
                  </ShadButton>
                ) : (
                  <IconButton aria-label="Open settings" onClick={() => navigateTo('/settings')}>
                    <Settings size={18} />
                  </IconButton>
                )}
                {isShadcnTheme ? (
                  <ShadButton onClick={() => void openIdeSession()} disabled={isProctorStarting}>
                    {isProctorStarting ? <Loader2 className="size-4 animate-spin" /> : <Play size={16} />}
                    Open IDE
                  </ShadButton>
                ) : (
                  <Button
                    variant="contained"
                    startIcon={isProctorStarting ? <CircularProgress size={16} /> : <Play size={16} />}
                    onClick={() => void openIdeSession()}
                    disabled={isProctorStarting}
                  >
                    Open IDE
                  </Button>
                )}
              </Stack>
            </Stack>

            <Box sx={{ maxWidth: 1180, mx: 'auto', p: { xs: 2, md: 3 } }}>
              <Stack spacing={3}>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 3,
                    borderRadius: isShadcnTheme ? 2 : 1,
                    bgcolor: isShadcnTheme ? 'var(--locom-card)' : 'background.paper',
                  }}
                >
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={2}
                    sx={{ alignItems: { xs: 'stretch', md: 'center' }, justifyContent: 'space-between' }}
                  >
                    <Box>
                      <Typography variant="h4" sx={{ fontWeight: 800, mb: 1 }}>
                        Dashboard
                      </Typography>
                      <Typography color="text.secondary">
                        Track your practice, open LC-style problems, and jump into the IDE.
                      </Typography>
                    </Box>
                    <Typography variant="body2" color="text.secondary">
                      {isAntiCheatEnabled ? 'Anti-cheat is enabled in Settings.' : 'Anti-cheat is off.'}
                    </Typography>
                  </Stack>
                </Paper>

                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
                    gap: 2,
                  }}
                >
                  {statCards.map((card) => (
                    <Paper
                      key={card.label}
                      variant="outlined"
                      sx={{
                        p: 2,
                        borderRadius: isShadcnTheme ? 2 : 1,
                        bgcolor: isShadcnTheme ? 'var(--locom-card)' : 'background.paper',
                      }}
                    >
                      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', mb: 1 }}>
                        {card.icon}
                        <Typography variant="body2" color="text.secondary">
                          {card.label}
                        </Typography>
                      </Stack>
                      <Typography variant="h5" sx={{ fontWeight: 800 }}>
                        {card.value}
                      </Typography>
                    </Paper>
                  ))}
                </Box>

                {lcError && (
                  <Alert severity="warning" icon={<AlertTriangle size={18} />}>
                    {lcError}
                  </Alert>
                )}

                <Paper
                  variant="outlined"
                  sx={{
                    borderRadius: isShadcnTheme ? 2 : 1,
                    overflow: 'hidden',
                    bgcolor: isShadcnTheme ? 'var(--locom-card)' : 'background.paper',
                  }}
                >
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={1.5}
                    sx={{
                      alignItems: { xs: 'stretch', md: 'center' },
                      justifyContent: 'space-between',
                      px: 2,
                      py: 1.5,
                      borderBottom: 1,
                      borderColor: isShadcnTheme ? 'var(--locom-border)' : 'divider',
                    }}
                  >
                    <Typography sx={{ fontWeight: 800 }}>Problems</Typography>
                    {isShadcnTheme ? (
                      <ShadInput
                        value={problemSearch}
                        onChange={(event) => setProblemSearch(event.target.value)}
                        placeholder="Search problems..."
                        className="h-9 w-full md:w-[360px]"
                      />
                    ) : (
                      <TextField
                        value={problemSearch}
                        onChange={(event) => setProblemSearch(event.target.value)}
                        placeholder="Search problems..."
                        size="small"
                        sx={{
                          width: { xs: '100%', md: 360 },
                          '& .MuiInputBase-root': {
                            height: 36,
                          },
                        }}
                      />
                    )}
                    {isShadcnTheme ? (
                      <ShadButton
                        variant="ghost"
                        size="sm"
                        onClick={() => void loadLcDashboard()}
                        disabled={isLcLoading}
                      >
                        Refresh
                      </ShadButton>
                    ) : (
                      <Button size="small" onClick={() => void loadLcDashboard()} disabled={isLcLoading}>
                        Refresh
                      </Button>
                    )}
                  </Stack>

                  <Stack divider={<Separator />} sx={{ maxHeight: 640, overflow: 'auto' }}>
                    {visibleProblems.length === 0 && (
                      <Box sx={{ p: 3 }}>
                        <Typography color="text.secondary">
                          {isLcLoading
                            ? 'Loading problems...'
                            : normalizedProblemSearch
                              ? 'No problems match your search.'
                              : 'No exposed Supabase table with rows was found.'}
                        </Typography>
                      </Box>
                    )}
                    {visibleProblems.map((problem) => (
                      <Stack
                        key={problem.id}
                        direction={{ xs: 'column', md: 'row' }}
                        spacing={2}
                        sx={{
                          alignItems: { xs: 'stretch', md: 'center' },
                          justifyContent: 'space-between',
                          p: 2,
                          '&:hover': { bgcolor: 'action.hover' },
                        }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                            <Typography variant="body2" color="text.secondary">
                              {problem.frontendId || problem.id}.
                            </Typography>
                            <Typography sx={{ fontWeight: 800 }} noWrap>
                              {problem.title}
                            </Typography>
                            <Typography
                              variant="caption"
                              color={
                                problem.difficulty === 'Easy'
                                  ? 'success.main'
                                  : problem.difficulty === 'Hard'
                                    ? 'error.main'
                                    : 'warning.main'
                              }
                            >
                              {problem.difficulty}
                            </Typography>
                          </Stack>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                            <Typography variant="caption" color="text.secondary">
                              AC {formatAcceptanceRate(problem.acceptanceRate)}
                            </Typography>
                            {problem.tags.slice(0, 3).map((tag) => (
                              <Typography key={tagLabel(tag)} variant="caption" color="text.secondary">
                                {tagLabel(tag)}
                              </Typography>
                            ))}
                            {problem.isPaidOnly && (
                              <Typography variant="caption" color="warning.main">
                                Premium
                              </Typography>
                            )}
                          </Stack>
                        </Box>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          {isShadcnTheme ? (
                            <>
                              <ShadButton
                                variant="outline"
                                size="sm"
                                onClick={() => void showProblem(problem)}
                                disabled={isProblemDetailLoading}
                              >
                                {isProblemDetailLoading ? 'Loading...' : 'Show Problem'}
                              </ShadButton>
                              <ShadButton
                                size="sm"
                                onClick={() => void openIdeSession(problem)}
                                disabled={isProctorStarting || isProblemDetailLoading}
                              >
                                Solve Problem
                              </ShadButton>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="outlined"
                                size="small"
                                onClick={() => void showProblem(problem)}
                                disabled={isProblemDetailLoading}
                              >
                                {isProblemDetailLoading ? 'Loading...' : 'Show Problem'}
                              </Button>
                              <Button
                                variant="contained"
                                size="small"
                                onClick={() => void openIdeSession(problem)}
                                disabled={isProctorStarting || isProblemDetailLoading}
                              >
                                Solve Problem
                              </Button>
                            </>
                          )}
                        </Stack>
                      </Stack>
                    ))}
                  </Stack>
                </Paper>              </Stack>
            </Box>
          </Box>
          {isShadcnTheme ? (
            <Toaster theme={isCompilerDark ? 'dark' : 'light'} position="top-center" closeButton />
          ) : (
            <Snackbar
              open={Boolean(notice)}
              autoHideDuration={3500}
              onClose={() => setNotice(null)}
              anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
            >
              <Alert
                severity={notice?.severity ?? 'info'}
                variant="filled"
                onClose={() => setNotice(null)}
                sx={{ width: '100%' }}
              >
                {notice?.message}
              </Alert>
            </Snackbar>
          )}
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  if (currentPath === '/settings' && isShadcnTheme) {
    return (
      <TooltipProvider>
        <div className="min-h-screen bg-background p-6 text-foreground">
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            <div className="flex items-center justify-between">
              <div className="font-mono text-sm font-semibold">
                {'</locom>'}
              </div>
              <ShadButton variant="outline" onClick={() => navigateTo('/')}>
                Back
              </ShadButton>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Settings</CardTitle>
                <CardDescription>Change the compiler interface theme and appearance.</CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="theme" className="gap-5">
                  <TabsList>
                    <TabsTrigger value="theme">Theme</TabsTrigger>
                    <TabsTrigger value="editor">Editor</TabsTrigger>
                  </TabsList>

                  <TabsContent value="theme">
                    <div className="grid gap-5">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-medium">Component Theme</div>
                          <div className="text-sm text-muted-foreground">
                            Material UI or shadcn controls.
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <ShadButton variant="outline" onClick={useMaterialTheme}>
                            Material
                          </ShadButton>
                          <ShadButton onClick={useShadcnTheme}>shadcn</ShadButton>
                        </div>
                      </div>

                      <Separator />

                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-medium">Color Mode</div>
                          <div className="text-sm text-muted-foreground">
                            Switch between the light and dark compiler surfaces.
                          </div>
                        </div>
                        <ShadButton
                          variant="outline"
                          onClick={() => setIsDarkMode((current) => !current)}
                        >
                          {isDarkMode ? 'Light mode' : 'Dark mode'}
                        </ShadButton>
                      </div>

                      <Separator />

                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-medium">Anti-cheat Mode</div>
                          <div className="text-sm text-muted-foreground">
                            When enabled, opening the IDE asks for screen, camera, and microphone.
                          </div>
                        </div>
                        <ShadButton
                          variant={isAntiCheatEnabled ? 'default' : 'outline'}
                          onClick={() => setIsAntiCheatEnabled((current) => !current)}
                        >
                          {isAntiCheatEnabled ? 'Enabled' : 'Disabled'}
                        </ShadButton>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="editor">
                    <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
                      The editor follows your selected color mode and language.
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </div>
      </TooltipProvider>
    );
  }

  if (currentPath === '/settings') {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box
          sx={{
            minHeight: '100vh',
            bgcolor: isShadcnTheme ? 'var(--locom-bg)' : 'background.default',
            color: 'text.primary',
            p: 3,
            ...shadcnStyles,
          }}
        >
          <Stack spacing={3} sx={{ maxWidth: 760, mx: 'auto' }}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Box
                sx={{
                  px: 0,
                  py: 1,
                  fontFamily:
                    '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
                  fontWeight: 700,
                }}
              >
                {'</locom>'}
              </Box>
              <Button variant="outlined" onClick={() => navigateTo('/')}>
                Back
              </Button>
            </Stack>

            <Paper
              variant="outlined"
              sx={{
                p: 3,
                borderRadius: isShadcnTheme ? 1.5 : 1,
                bgcolor: isShadcnTheme ? 'var(--locom-card)' : 'background.paper',
              }}
            >
              <Typography variant="h5" sx={{ mb: 1, fontWeight: 700 }}>
                Settings
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                Choose the interface theme and editor appearance.
              </Typography>

              <Stack spacing={2}>
                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Box>
                    <Typography variant="subtitle1">Component Theme</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Switch between Material UI and shadcn-style controls.
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    <Button
                      variant={!isShadcnTheme ? 'contained' : 'outlined'}
                      onClick={useMaterialTheme}
                    >
                      Material
                    </Button>
                    <Button variant={isShadcnTheme ? 'contained' : 'outlined'} onClick={useShadcnTheme}>
                      shadcn
                    </Button>
                  </Stack>
                </Stack>

                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Box>
                    <Typography variant="subtitle1">Color Mode</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Change the compiler and assistant between light and dark.
                    </Typography>
                  </Box>
                  <Button variant="outlined" onClick={() => setIsDarkMode((current) => !current)}>
                    {isDarkMode ? 'Light mode' : 'Dark mode'}
                  </Button>
                </Stack>

                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Box>
                    <Typography variant="subtitle1">Anti-cheat Mode</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Require screen sharing, camera, and microphone only when this option is enabled.
                    </Typography>
                  </Box>
                  <Button
                    variant={isAntiCheatEnabled ? 'contained' : 'outlined'}
                    onClick={() => setIsAntiCheatEnabled((current) => !current)}
                  >
                    {isAntiCheatEnabled ? 'Enabled' : 'Disabled'}
                  </Button>
                </Stack>
              </Stack>
            </Paper>
          </Stack>
        </Box>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <TooltipProvider>
      <CssBaseline />
      <GlobalStyles
        styles={{
          html: { height: '100%' },
          body: { minHeight: '100%', overflow: 'hidden' },
          '#root': { minHeight: '100%' },
          '*': {
            scrollbarWidth: 'thin',
            scrollbarColor: isCompilerDark || isShadcnTheme ? '#6b7280 transparent' : '#9ca3af transparent',
          },
          '*::-webkit-scrollbar': {
            width: 7,
            height: 7,
          },
          '*::-webkit-scrollbar-track': {
            background: 'transparent',
          },
          '*::-webkit-scrollbar-thumb': {
            backgroundColor: isCompilerDark || isShadcnTheme ? '#6b7280' : '#9ca3af',
            borderRadius: 999,
          },
          '*::-webkit-scrollbar-thumb:hover': {
            backgroundColor: isCompilerDark || isShadcnTheme ? '#9ca3af' : '#6b7280',
          },
          '*::-webkit-scrollbar-corner': {
            background: 'transparent',
          },
          '*::-webkit-scrollbar-button': {
            display: 'none',
            width: 0,
            height: 0,
          },
          '.cm-editor': {
            height: '100%',
            minHeight: '100%',
            backgroundColor: isCompilerDark ? '#0d1117' : '#ffffff',
            color: isCompilerDark ? '#e6edf3' : '#1f2328',
            fontSize: '15px',
            fontFamily:
              '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
          },
          '.cm-scroller': {
            backgroundColor: isCompilerDark ? '#0d1117' : '#ffffff',
            overflow: 'auto',
          },
          '.cm-focused': {
            outline: 'none !important',
          },
          '.cm-gutters': {
            backgroundColor: isCompilerDark ? '#161b22' : '#f6f8fa',
            borderRight: 'none',
            margin: 0,
            padding: 0,
          },
          '.cm-activeLine, .cm-activeLineGutter': {
            backgroundColor: 'transparent !important',
          },
          '.cm-selectionBackground': {
            backgroundColor: isCompilerDark ? '#3b4960 !important' : '#bcd7ff !important',
          },
          '.cm-line': {
            paddingLeft: 0,
            paddingRight: 0,
          },
          '.cm-content': {
            paddingTop: 0,
          },
          '.cm-gutterElement': {
            minWidth: '28px',
            paddingLeft: 0,
            paddingRight: '4px',
            textAlign: 'right',
          },
          '@keyframes aiButtonSpin': {
            '0%': { transform: 'rotate(0deg) scale(1)' },
            '72%': { transform: 'rotate(300deg) scale(1.08)' },
            '100%': { transform: 'rotate(360deg) scale(1)' },
          },
          '.locom-ai-button:hover img': {
            animation: 'aiButtonSpin 1.15s cubic-bezier(0.16, 1, 0.3, 1) 1',
          },
          '.locom-problem-content': {
            fontSize: 15,
            lineHeight: 1.75,
          },
          '.locom-problem-content p': {
            margin: '0 0 12px',
          },
          '.locom-problem-content pre': {
            margin: '12px 0',
            padding: '12px 14px',
            overflow: 'auto',
            borderRadius: 8,
            backgroundColor: isCompilerDark ? '#0d1117' : '#f6f8fa',
            border: `1px solid ${isCompilerDark ? '#30363d' : '#d8dee4'}`,
            fontFamily:
              '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
          },
          '.locom-problem-content code': {
            padding: '2px 5px',
            borderRadius: 5,
            backgroundColor: isCompilerDark ? '#161b22' : '#eef1f4',
            fontFamily:
              '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
            fontSize: '0.92em',
          },
          '.locom-problem-content ul, .locom-problem-content ol': {
            paddingLeft: 24,
            margin: '8px 0 12px',
          },
          '.locom-problem-content li': {
            marginBottom: 6,
          },
        }}
      />
      <Box
        sx={{
          height: '100vh',
          bgcolor: isShadcnTheme ? 'var(--locom-bg)' : 'background.default',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          ...shadcnStyles,
        }}
      >
        <Stack
          direction="row"
          spacing={2}
          sx={{
            alignItems: 'center',
            justifyContent: 'initial',
            flexWrap: 'nowrap',
            width: '100%',
            display: 'flex',
            position: 'relative',
            columnGap: 2,
            bgcolor: isShadcnTheme ? 'var(--locom-bg)' : 'background.default',
            borderBottom: 1,
            borderColor: isShadcnTheme ? 'var(--locom-border)' : 'divider',
            px: 0,
            height: 57,
            py: 0,
          }}
        >
          <Box
            sx={{
              ml: 0,
              px: 2,
              height: 40,
              display: 'flex',
              alignItems: 'center',
              color: isShadcnTheme ? 'var(--foreground)' : 'inherit',
              fontFamily:
                '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
              fontWeight: 700,
            }}
          >
            {'</locom>'}
          </Box>

          <Box
            sx={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              height: 40,
              px: 1,
              border: '1px solid',
              borderColor: isShadcnTheme ? 'var(--locom-border)' : 'divider',
              borderRadius: isShadcnTheme ? 2 : 1,
              bgcolor: isShadcnTheme ? 'var(--locom-card)' : 'background.paper',
              color: isShadcnTheme ? 'var(--foreground)' : 'text.primary',
              fontFamily:
                '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
            }}
          >
            <Timer size={16} />
            <Box component="span" sx={{ minWidth: 48, textAlign: 'center', fontSize: 14 }}>
              {formatTimer(timerSeconds)}
            </Box>
            {isShadcnTheme ? (
              <ShadButton
                variant="ghost"
                size="icon-sm"
                aria-label={isTimerRunning ? 'Stop timer' : 'Start timer'}
                onClick={() => setIsTimerRunning((current) => !current)}
              >
                {isTimerRunning ? <Pause size={15} /> : <Play size={15} />}
              </ShadButton>
            ) : (
              <IconButton
                size="small"
                aria-label={isTimerRunning ? 'Stop timer' : 'Start timer'}
                onClick={() => setIsTimerRunning((current) => !current)}
                sx={{ width: 28, height: 28 }}
              >
                {isTimerRunning ? <Pause size={15} /> : <Play size={15} />}
              </IconButton>
            )}
            {isShadcnTheme ? (
              <ShadButton
                variant="ghost"
                size="icon-sm"
                aria-label="Reset timer"
                onClick={() => {
                  setIsTimerRunning(false);
                  setTimerSeconds(0);
                }}
              >
                <RotateCcw size={14} />
              </ShadButton>
            ) : (
              <IconButton
                size="small"
                aria-label="Reset timer"
                onClick={() => {
                  setIsTimerRunning(false);
                  setTimerSeconds(0);
                }}
                sx={{ width: 28, height: 28 }}
              >
                <RotateCcw size={14} />
              </IconButton>
            )}
          </Box>

          <Stack
            direction="row"
            spacing={2}
            sx={{
              alignItems: 'center',
              justifyContent: 'flex-end',
              position: 'absolute',
              right: { xs: 6, md: 8 },
              top: '50%',
              transform: 'translateY(-50%)',
              minWidth: 0,
            }}
          >

          {!isProctorActive && (
            isShadcnTheme ? (
              <ShadTooltip>
                <TooltipTrigger asChild>
                  <ShadButton
                    className="locom-ai-button !h-10 !w-10"
                    variant="outline"
                    size="icon"
                    aria-label="Open AI assistant"
                    onClick={() => setIsAiOpen(true)}
                  >
                    <img src="/star-ai-loader.svg" alt="" className="block size-6" />
                  </ShadButton>
                </TooltipTrigger>
                <TooltipContent>AI assistant</TooltipContent>
              </ShadTooltip>
            ) : (
              <Tooltip title="AI assistant">
                <IconButton
                  className="locom-ai-button"
                  color="inherit"
                  aria-label="Open AI assistant"
                  onClick={() => setIsAiOpen(true)}
                  sx={{ width: 40, height: 40 }}
                >
                  <Box
                    component="img"
                    src="/star-ai-loader.svg"
                    alt=""
                    sx={{ width: 24, height: 24, display: 'block' }}
                  />
                </IconButton>
              </Tooltip>
            )
          )}

          {isShadcnTheme ? (
            <ShadTooltip>
              <TooltipTrigger asChild>
                <ShadButton
                  className="!h-10 !w-10"
                  variant="outline"
                  size="icon"
                  aria-label="Open settings"
                  onClick={() => navigateTo('/settings')}
                >
                  <Settings size={20} />
                </ShadButton>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </ShadTooltip>
          ) : (
            <Tooltip title="Settings">
              <IconButton
                color="inherit"
                aria-label="Open settings"
                onClick={() => navigateTo('/settings')}
                sx={{ width: 40, height: 40 }}
              >
                <Settings size={20} />
              </IconButton>
            </Tooltip>
          )}

          {isShadcnTheme ? (
            <ShadSelect
              value={language}
              onValueChange={(nextLanguage) => handleLanguageChange(nextLanguage as Language)}
            >
              <SelectTrigger className="!h-10 w-36 justify-between rounded-lg px-3 text-sm [&_svg]:ml-3">
                <SelectValue placeholder="Language" />
              </SelectTrigger>
              <SelectContent
                position="popper"
                align="start"
                sideOffset={4}
                className="z-[10001] min-w-36 rounded-lg"
              >
                <SelectItem className="pl-3 pr-10" value="python">
                  Python
                </SelectItem>
                <SelectItem className="pl-3 pr-10" value="cpp">
                  C++
                </SelectItem>
              </SelectContent>
            </ShadSelect>
          ) : (
            <FormControl
              size="small"
              sx={{
                width: 120,
                '& .MuiInputBase-root': {
                  height: 40,
                },
              }}
            >
              <Select
                value={language}
                onChange={(event) => handleLanguageChange(event.target.value as Language)}
              >
                <MenuItem value="python">Python</MenuItem>
                <MenuItem value="cpp">C++</MenuItem>
              </Select>
            </FormControl>
          )}

          {isShadcnTheme ? (
            <ShadButton
              className="!h-10 !w-10"
              onClick={runCode}
              disabled={isRunning}
              aria-label="Run code"
            >
              {isRunning ? <Loader2 className="size-4 animate-spin" /> : <Play size={16} />}
            </ShadButton>
          ) : (
            <Button
              variant="contained"
              size="medium"
              aria-label="Run code"
              onClick={runCode}
              disabled={isRunning}
              sx={controlButtonSx}
            >
              {isRunning ? <CircularProgress color="inherit" size={16} /> : <PlayArrowRoundedIcon />}
            </Button>
          )}
          </Stack>
        </Stack>

        <Box
          component="main"
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              md: `minmax(280px, ${leftPaneWidth}%) 6px minmax(280px, 1fr)`,
            },
            gap: 0,
            p: 0,
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <Stack sx={{ height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
            <Paper
              variant="outlined"
              sx={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 300,
                resize: 'vertical',
                overflow: 'hidden',
                borderRadius: 0,
                bgcolor: isShadcnTheme ? 'var(--locom-card)' : undefined,
              }}
            >
              <Box sx={{ flex: 1, minHeight: 0 }}>
                <CodeMirror
                  value={code}
                  height="100%"
                  extensions={editorExtensions}
                  onChange={(nextCode) => setCode(nextCode)}
                  basicSetup={{
                    foldGutter: false,
                    highlightActiveLine: false,
                    highlightActiveLineGutter: false,
                    lineNumbers: true,
                  }}
                  style={{ height: '100%' }}
                />
              </Box>
            </Paper>
          </Stack>

          <Box
            onPointerDown={startHorizontalResize}
            sx={{
              display: { xs: 'none', md: 'block' },
              cursor: 'col-resize',
              bgcolor: 'divider',
              touchAction: 'none',
              '&:hover': {
                bgcolor: 'primary.main',
              },
            }}
          />

          <Paper
            variant="outlined"
            sx={{
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
              bgcolor: terminalBackground,
              borderRadius: 0,
            }}
          >
            <Box
              component="pre"
              sx={{
                flex: 1,
                m: 0,
                p: 3,
                overflow: 'auto',
                borderTop: 0,
                borderColor: 'divider',
                bgcolor: terminalBackground,
                color: terminalText,
                fontFamily:
                  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
                fontSize: 16,
                fontWeight: 400,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {outputText}
            </Box>
          </Paper>
        </Box>
      </Box>
      {isShadcnTheme ? (
        <Sheet open={isAiOpen} onOpenChange={setIsAiOpen}>
          <SheetContent
            className="!top-0 z-[10000] !h-screen gap-0 border-border bg-background p-0 sm:!max-w-none"
            style={{ width: aiSidebarWidth, maxWidth: 'calc(100vw - 24px)' }}
            showCloseButton
          >
            <div
              aria-hidden="true"
              onPointerDown={startAiSidebarResize}
              className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-transparent hover:bg-border"
            />
            <SheetHeader className="h-[57px] justify-center border-b border-border px-6 py-0">
              <SheetTitle>Locom AI</SheetTitle>
            </SheetHeader>

            <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
              {aiMessages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={
                    message.role === 'user'
                      ? 'max-w-[92%] self-end rounded-lg bg-primary px-3 py-2 text-sm leading-6 text-primary-foreground'
                      : 'max-w-[92%] self-start rounded-lg border border-border px-3 py-2 text-foreground'
                  }
                >
                  {message.role === 'assistant' ? <MarkdownMessage content={message.content} /> : message.content}
                </div>
              ))}

              {isAiLoading && <div className="text-sm text-muted-foreground">Thinking...</div>}
            </div>

            <SheetFooter className="border-t border-border p-4">
              <div className="flex w-full gap-2">
                <ShadTextarea
                  value={aiQuestion}
                  onChange={(event) => setAiQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      askAi();
                    }
                  }}
                  className="max-h-32 min-h-10 resize-none"
                  placeholder="Ask for a hint..."
                />
                <ShadButton
                  className="h-10 w-10"
                  size="icon"
                  aria-label="Ask AI"
                  onClick={askAi}
                  disabled={isAiLoading || !aiQuestion.trim()}
                >
                  <Send size={16} />
                </ShadButton>
              </div>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      ) : (
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            right: isAiOpen ? 0 : -aiSidebarWidth,
            bottom: 0,
            width: { xs: '100%', sm: aiSidebarWidth },
            zIndex: 10000,
            display: 'flex',
            flexDirection: 'column',
            bgcolor: 'background.paper',
            borderLeft: 1,
            borderColor: 'divider',
            boxShadow: 8,
            transition: 'right 180ms ease',
          }}
        >
          <Box
            aria-hidden="true"
            onPointerDown={startAiSidebarResize}
            sx={{
              position: 'absolute',
              insetBlock: 0,
              left: 0,
              zIndex: 1,
              width: 4,
              cursor: 'col-resize',
              bgcolor: 'transparent',
              '&:hover': {
                bgcolor: 'divider',
              },
            }}
          />
          <Stack
            direction="row"
            sx={{
              alignItems: 'center',
              justifyContent: 'space-between',
              height: 57,
              px: 3,
              py: 0,
              borderBottom: 1,
              borderColor: 'divider',
            }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              Locom AI
            </Typography>
            <IconButton aria-label="Close AI assistant" onClick={() => setIsAiOpen(false)}>
              <X size={18} />
            </IconButton>
          </Stack>

          <Stack spacing={1.25} sx={{ flex: 1, overflow: 'auto', p: 2 }}>
            {aiMessages.map((message, index) => (
              <Box
                key={`${message.role}-${index}`}
                sx={{
                  alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '92%',
                  px: 1.5,
                  py: 1,
                  borderRadius: 2,
                  bgcolor: message.role === 'user' ? 'primary.main' : 'action.hover',
                  color: message.role === 'user' ? 'primary.contrastText' : 'text.primary',
                  whiteSpace: 'pre-wrap',
                  fontSize: 14,
                  lineHeight: 1.55,
                }}
              >
                {message.role === 'assistant' ? <MarkdownMessage content={message.content} /> : message.content}
              </Box>
            ))}

            {isAiLoading && (
              <Typography variant="body2" color="text.secondary">
                Thinking...
              </Typography>
            )}
          </Stack>

          <Stack direction="row" spacing={1} sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
            <TextField
              value={aiQuestion}
              onChange={(event) => setAiQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  askAi();
                }
              }}
              multiline
              maxRows={4}
              fullWidth
              size="small"
              placeholder="Ask for a hint..."
            />
            <Button
              variant="contained"
              aria-label="Ask AI"
              onClick={askAi}
              disabled={isAiLoading || !aiQuestion.trim()}
              sx={{ minWidth: 44 }}
            >
              <Send size={16} />
            </Button>
          </Stack>
        </Box>
      )}
      {isShadcnTheme ? (
        <Toaster theme={isCompilerDark ? 'dark' : 'light'} position="top-center" closeButton />
      ) : (
        <Snackbar
          open={Boolean(notice)}
          autoHideDuration={3500}
          onClose={() => setNotice(null)}
          anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        >
          <Alert
            severity={notice?.severity ?? 'info'}
            variant="filled"
            onClose={() => setNotice(null)}
            sx={{ width: '100%' }}
          >
            {notice?.message}
          </Alert>
        </Snackbar>
      )}
      </TooltipProvider>
    </ThemeProvider>
  );
}

