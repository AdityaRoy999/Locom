import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cors from 'cors';
import express from 'express';

const app = express();
const port = process.env.PORT || 3001;
const runTimeoutMs = 5000;
const compileTimeoutMs = 10000;
const nvidiaBaseUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
const nvidiaModel = process.env.NVIDIA_MODEL || 'google/gemma-2-2b-it';
const supabaseTable = process.env.SUPABASE_LC_TABLE || 'lc_tracker';
const supabaseSchema = process.env.SUPABASE_LC_SCHEMA || 'public';
const supabaseEventsTable = process.env.SUPABASE_LC_EVENTS_TABLE || '';
const hfDatasetRowsUrl =
  'https://datasets-server.huggingface.co/rows?dataset=kaysss%2Fleetcode-problem-detailed&config=default&split=train';
const hfCacheTtlMs = 1000 * 60 * 60;
let hfProblemCache = null;
let hfProblemCachePromise = null;
const catalogCacheTtlMs = 1000 * 60 * 5;
let catalogCache = null;
let catalogCachePromise = null;
const problemDetailCache = new Map();

function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      continue;
    }

    const [key, ...valueParts] = trimmed.split('=');
    if (!process.env[key]) {
      process.env[key] = valueParts.join('=');
    }
  }
}

loadLocalEnv();

app.use(cors());
app.use(express.json({ limit: '512kb' }));

const clientDistPath = path.resolve(process.cwd(), 'dist');
if (existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
}

const supportedLanguages = new Set(['python', 'cpp']);
const problemLikeColumns = new Set([
  'title',
  'name',
  'problem_name',
  'question_title',
  'slug',
  'statement',
  'description',
  'prompt',
  'question',
  'difficulty',
  'level',
  'status',
  'solved',
  'completed',
]);

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return null;
  }

  return {
    url: url.replace(/\/$/, ''),
    key,
  };
}

function safeTableName(tableName) {
  return /^[a-zA-Z0-9_]+$/.test(tableName) ? tableName : 'lc_tracker';
}

async function supabaseRequest(pathname, options = {}) {
  const config = getSupabaseConfig();
  if (!config) {
    const error = new Error('Supabase is not configured. Add SUPABASE_URL and a Supabase API key to .env.local.');
    error.status = 503;
    throw error;
  }

  const response = await fetch(`${config.url}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      'Accept-Profile': supabaseSchema,
      'Content-Profile': supabaseSchema,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(data?.message || data?.hint || `Supabase request failed (${response.status}).`);
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

async function supabaseOpenApi() {
  const config = getSupabaseConfig();
  if (!config) {
    const error = new Error('Supabase is not configured. Add SUPABASE_URL and a Supabase API key to .env.local.');
    error.status = 503;
    throw error;
  }

  const response = await fetch(`${config.url}/rest/v1/`, {
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      'Accept-Profile': supabaseSchema,
    },
  });
  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data?.message || `Unable to inspect Supabase schema (${response.status}).`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function scoreTableSample(tableName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  const columns = new Set(Object.keys(rows[0] || {}));
  let score = Math.min(rows.length, 3);
  for (const column of columns) {
    if (problemLikeColumns.has(column)) {
      score += 5;
    }
  }

  if (/lc|leet|problem|question|challenge|tracker/i.test(tableName)) {
    score += 8;
  }

  return score;
}

async function fetchRowsFromTable(tableName, limit = 1000) {
  const table = safeTableName(tableName);
  const rows = [];
  const pageSize = 1000;

  for (let offset = 0; offset < limit; offset += pageSize) {
    const end = Math.min(offset + pageSize - 1, limit - 1);
    const page = await supabaseRequest(`${table}?select=*`, {
      headers: {
        Range: `${offset}-${end}`,
      },
    });

    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    rows.push(...page);

    if (page.length < pageSize) {
      break;
    }
  }

  return rows;
}

async function fetchHfProblemDetails() {
  const now = Date.now();
  if (hfProblemCache && now - hfProblemCache.loadedAt < hfCacheTtlMs) {
    return hfProblemCache;
  }

  if (hfProblemCachePromise) {
    return hfProblemCachePromise;
  }

  hfProblemCachePromise = loadHfProblemDetails();

  try {
    return await hfProblemCachePromise;
  } finally {
    hfProblemCachePromise = null;
  }
}

async function loadHfProblemDetails() {
  const now = Date.now();
  const firstResponse = await fetch(`${hfDatasetRowsUrl}&offset=0&length=100`);
  const firstData = await firstResponse.json();

  if (!firstResponse.ok) {
    const error = new Error(firstData?.error || `Unable to load Hugging Face dataset (${firstResponse.status}).`);
    error.status = firstResponse.status;
    throw error;
  }

  const totalRows = Number(firstData.num_rows_total || 0);
  const rows = (firstData.rows || []).map((entry) => entry.row);
  const requests = [];

  for (let offset = 100; offset < totalRows; offset += 100) {
    requests.push(
      fetch(`${hfDatasetRowsUrl}&offset=${offset}&length=100`)
        .then((response) => response.json())
        .then((data) => (data.rows || []).map((entry) => entry.row)),
    );
  }

  const pages = await Promise.all(requests);
  for (const page of pages) {
    rows.push(...page);
  }

  const bySlug = new Map();
  const byFrontendId = new Map();
  for (const row of rows) {
    if (row.TitleSlug) {
      bySlug.set(String(row.TitleSlug), row);
    }

    if (row.questionFrontendId !== undefined && row.questionFrontendId !== null) {
      byFrontendId.set(String(row.questionFrontendId), row);
    }
  }

  hfProblemCache = {
    loadedAt: now,
    rows,
    bySlug,
    byFrontendId,
  };

  return hfProblemCache;
}

async function enrichProblemsWithDetails(rows) {
  try {
    const details = await fetchHfProblemDetails();
    const supabaseBySlug = new Map();
    const supabaseByFrontendId = new Map();
    for (const row of rows) {
      if (row.slug || row.TitleSlug) {
        supabaseBySlug.set(String(row.slug || row.TitleSlug), row);
      }

      if (row.frontend_id || row.questionFrontendId || row.id) {
        supabaseByFrontendId.set(String(row.frontend_id || row.questionFrontendId || row.id), row);
      }
    }

    if (details.rows.length > rows.length) {
      return details.rows.map((detail) => {
        const match =
          supabaseBySlug.get(String(detail.TitleSlug || '')) ||
          supabaseByFrontendId.get(String(detail.questionFrontendId || ''));

        return match ? { ...detail, ...match, ...detail } : detail;
      });
    }

    const mergedRows = rows.map((row) => {
      const detail =
        details.bySlug.get(String(row.slug || row.TitleSlug || '')) ||
        details.byFrontendId.get(String(row.frontend_id || row.questionFrontendId || row.id || ''));

      return detail ? { ...detail, ...row, ...detail } : row;
    });

    if (mergedRows.length > 0) {
      return mergedRows;
    }

    return details.rows;
  } catch {
    return rows;
  }
}

async function fetchHfProblemDetail(baseRow) {
  const frontendId = Number(baseRow.frontend_id || baseRow.questionFrontendId || baseRow.id);
  const slug = String(baseRow.slug || baseRow.TitleSlug || '');

  if (Number.isFinite(frontendId) && frontendId > 0) {
    const offset = Math.max(0, frontendId - 1);
    try {
      const response = await fetch(`${hfDatasetRowsUrl}&offset=${offset}&length=5`);
      const data = await response.json();
      const rows = (data.rows || []).map((entry) => entry.row);
      const directMatch =
        rows.find((row) => String(row.TitleSlug || '') === slug) ||
        rows.find((row) => String(row.questionFrontendId || '') === String(frontendId));

      if (directMatch) {
        return directMatch;
      }
    } catch {
      // Fall back to the full cached dataset below.
    }
  }

  const details = await fetchHfProblemDetails();
  return details.bySlug.get(slug) || details.byFrontendId.get(String(frontendId)) || null;
}

async function discoverProblemRows(limit = 1000) {
  const now = Date.now();
  if (catalogCache && now - catalogCache.loadedAt < catalogCacheTtlMs && catalogCache.limit >= limit) {
    return {
      table: catalogCache.table,
      rows: catalogCache.rows.slice(0, limit),
    };
  }

  if (catalogCachePromise) {
    const cached = await catalogCachePromise;
    return {
      table: cached.table,
      rows: cached.rows.slice(0, limit),
    };
  }

  catalogCachePromise = loadProblemRows(limit);

  try {
    return await catalogCachePromise;
  } finally {
    catalogCachePromise = null;
  }
}

async function loadProblemRows(limit = 1000) {
  const configuredTable = safeTableName(supabaseTable);

  try {
    const rows = await fetchRowsFromTable(configuredTable, limit);
    if (Array.isArray(rows) && rows.length > 0) {
      catalogCache = {
        loadedAt: Date.now(),
        limit,
        table: configuredTable,
        rows,
      };
      return { table: configuredTable, rows };
    }
  } catch {
    // Fall through to schema discovery when the configured table is absent.
  }

  const schema = await supabaseOpenApi();
  const tableNames = Object.keys(schema.paths || {})
    .map((pathname) => pathname.replace(/^\//, ''))
    .filter((tableName) => tableName && !tableName.startsWith('rpc/'));

  const candidates = [];
  for (const tableName of tableNames) {
    try {
      const rows = await fetchRowsFromTable(tableName, 5);
      candidates.push({
        table: tableName,
        rows,
        score: scoreTableSample(tableName, rows),
      });
    } catch {
      // Ignore tables/functions that are not readable with the configured key.
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates.find((candidate) => candidate.score > 0);
  if (!best) {
    catalogCache = {
      loadedAt: Date.now(),
      limit,
      table: configuredTable,
      rows: [],
    };
    return { table: configuredTable, rows: [] };
  }

  const rows = await fetchRowsFromTable(best.table, limit);
  catalogCache = {
    loadedAt: Date.now(),
    limit,
    table: best.table,
    rows,
  };

  return {
    table: best.table,
    rows,
  };
}

async function getProblemDetail(problemId) {
  const configuredTable = safeTableName(supabaseTable);
  const decodedId = decodeURIComponent(String(problemId || ''));
  const cachedProblem = problemDetailCache.get(decodedId);
  if (cachedProblem && Date.now() - cachedProblem.loadedAt < hfCacheTtlMs) {
    return {
      table: configuredTable,
      problem: cachedProblem.problem,
    };
  }

  let table = configuredTable;
  let baseRow =
    catalogCache?.rows.find((row) => String(row.slug || row.TitleSlug || '') === decodedId) ||
    catalogCache?.rows.find((row) => String(row.frontend_id || row.questionFrontendId || row.id || '') === decodedId) ||
    catalogCache?.rows.find((row) => String(row.title || row.questionTitle || '') === decodedId);

  if (!baseRow) {
    const filterValue = encodeURIComponent(decodedId);
    const attempts = [
      `${configuredTable}?select=*&slug=eq.${filterValue}&limit=1`,
      `${configuredTable}?select=*&frontend_id=eq.${filterValue}&limit=1`,
      `${configuredTable}?select=*&id=eq.${filterValue}&limit=1`,
    ];

    for (const attempt of attempts) {
      try {
        const rows = await supabaseRequest(attempt);
        if (Array.isArray(rows) && rows[0]) {
          baseRow = rows[0];
          break;
        }
      } catch {
        // Try the next likely identifier column.
      }
    }
  }

  if (!baseRow) {
    return { table, problem: null };
  }

  const detail = await fetchHfProblemDetail(baseRow);
  const enriched = detail ? [{ ...detail, ...baseRow, ...detail }] : [baseRow];
  const problem = normalizeProblem(enriched[0] || baseRow, 0);
  problemDetailCache.set(decodedId, {
    loadedAt: Date.now(),
    problem,
  });

  return {
    table,
    problem,
  };
}

function firstValue(row, keys, fallback = null) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }

  return fallback;
}

function parseMaybeJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback ?? value;
  }
}

function firstNumber(row, keys) {
  const value = firstValue(row, keys, 0);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSolved(row) {
  const status = String(firstValue(row, ['status', 'state', 'progress'], '')).toLowerCase();
  return Boolean(
    firstValue(row, ['solved', 'completed', 'is_solved', 'accepted'], false) ||
      status === 'solved' ||
      status === 'completed' ||
      status === 'accepted',
  );
}

function normalizeProblem(row, index) {
  const parsedCodeDefinition = parseMaybeJson(firstValue(row, ['codeDefinition', 'code_definition'], []), []);
  const parsedMetaData = parseMaybeJson(firstValue(row, ['metaData', 'metadata', 'meta_data'], null), null);
  const parsedEnvInfo = parseMaybeJson(firstValue(row, ['envInfo', 'env_info'], null), null);
  const parsedSimilarQuestions = parseMaybeJson(firstValue(row, ['similarQuestions', 'similar_questions'], []), []);
  const title = String(
    firstValue(row, ['title', 'questionTitle', 'name', 'problem_name', 'question_title', 'slug'], `Problem ${index + 1}`),
  );
  const tags = firstValue(row, ['tags', 'topics', 'category'], []);
  const topicTags = firstValue(row, ['topicTags', 'topic_tags'], null);
  const parsedTopicTags = parseMaybeJson(topicTags, topicTags);
  const normalizedTags = Array.isArray(parsedTopicTags)
    ? parsedTopicTags
    : Array.isArray(tags)
      ? tags
      : String(tags)
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean);

  return {
    id: String(firstValue(row, ['id', 'questionFrontendId', 'frontend_id', 'problem_id', 'slug'], index + 1)),
    frontendId: String(firstValue(row, ['questionFrontendId', 'frontend_id'], '')),
    title,
    slug: String(firstValue(row, ['TitleSlug', 'slug'], '')),
    difficulty: String(firstValue(row, ['difficulty', 'level'], 'Unknown')),
    statement: String(firstValue(row, ['statement', 'content', 'description', 'prompt', 'question'], '')),
    content: String(firstValue(row, ['content', 'statement', 'description', 'prompt', 'question'], '')),
    url: String(firstValue(row, ['url'], '')),
    acceptanceRate: firstValue(row, ['acRate', 'acceptance_rate'], null),
    totalAccepted: firstValue(row, ['totalAccepted'], null),
    totalSubmission: firstValue(row, ['totalSubmission'], null),
    codeDefinition: parsedCodeDefinition,
    sampleTestCase: String(firstValue(row, ['sampleTestCase', 'sample_test_case'], '')),
    metaData: parsedMetaData,
    envInfo: parsedEnvInfo,
    similarQuestions: parsedSimilarQuestions,
    category: firstValue(row, ['category'], null),
    isPaidOnly: Boolean(firstValue(row, ['is_paid_only', 'isPaidOnly'], false)),
    language: firstValue(row, ['language'], null),
    solved: isSolved(row),
    attempts: firstNumber(row, ['attempts', 'submission_count', 'tries']),
    timeSpentSeconds: firstNumber(row, [
      'time_spent_seconds',
      'time_spent',
      'duration_seconds',
      'seconds_spent',
      'total_time_seconds',
    ]),
    tags: normalizedTags.map((tag) => (typeof tag === 'string' ? { name: tag, slug: tag } : tag)),
    raw: row,
  };
}

function dashboardStats(problems) {
  const totalProblems = problems.length;
  const solvedProblems = problems.filter((problem) => problem.solved).length;
  const attemptedProblems = problems.filter((problem) => problem.attempts > 0 || problem.solved).length;
  const totalTimeSeconds = problems.reduce((sum, problem) => sum + problem.timeSpentSeconds, 0);
  const byDifficulty = problems.reduce((counts, problem) => {
    counts[problem.difficulty] = (counts[problem.difficulty] || 0) + 1;
    return counts;
  }, {});

  return {
    totalProblems,
    solvedProblems,
    attemptedProblems,
    totalTimeSeconds,
    byDifficulty,
  };
}

async function fetchTableCount(tableName) {
  const table = safeTableName(tableName);
  const config = getSupabaseConfig();
  if (!config) {
    return 0;
  }

  const response = await fetch(`${config.url}/rest/v1/${table}?select=id`, {
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      'Accept-Profile': supabaseSchema,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });

  if (!response.ok) {
    return 0;
  }

  const contentRange = response.headers.get('content-range') || '';
  const total = Number(contentRange.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

function dashboardStatsWithTotal(problems, totalProblems) {
  return {
    ...dashboardStats(problems),
    totalProblems: totalProblems || problems.length,
  };
}

function runProcess(command, args, options = {}) {
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (payload) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
        timedOut,
        ...payload,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? runTimeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      finish({ exitCode: 127, stderr: error.message });
    });

    child.on('close', (exitCode) => {
      finish({ exitCode: exitCode ?? 0 });
    });

    child.stdin.end(options.input ?? '');
  });
}

async function runPython(code, input, workdir) {
  const sourcePath = path.join(workdir, 'main.py');
  await writeFile(sourcePath, code);

  return runProcess('python', [sourcePath], {
    cwd: workdir,
    input,
    timeoutMs: runTimeoutMs,
  });
}

async function runCpp(code, input, workdir) {
  const sourcePath = path.join(workdir, 'main.cpp');
  const binaryPath = path.join(workdir, process.platform === 'win32' ? 'main.exe' : 'main');
  await writeFile(sourcePath, code);

  const compile = await runProcess(
    'g++',
    [sourcePath, '-std=c++17', '-O2', '-pipe', '-o', binaryPath],
    {
      cwd: workdir,
      timeoutMs: compileTimeoutMs,
    },
  );

  if (compile.exitCode !== 0 || compile.timedOut) {
    return { ...compile, stage: 'compile' };
  }

  const run = await runProcess(binaryPath, [], {
    cwd: workdir,
    input,
    timeoutMs: runTimeoutMs,
  });

  return { ...run, stage: 'run' };
}

app.post('/api/run', async (req, res) => {
  const language = String(req.body?.language ?? '');
  const code = String(req.body?.code ?? '');
  const input = String(req.body?.input ?? '');

  if (!supportedLanguages.has(language)) {
    return res.status(400).json({ message: 'Unsupported language.' });
  }

  if (!code.trim()) {
    return res.status(400).json({ message: 'Write some code first.' });
  }

  const workdir = await mkdtemp(path.join(tmpdir(), 'locom-'));

  try {
    const result =
      language === 'python'
        ? await runPython(code, input, workdir)
        : await runCpp(code, input, workdir);

    const output = [result.stdout, result.stderr].filter(Boolean).join('');

    return res.json({
      ok: result.exitCode === 0 && !result.timedOut,
      stage: result.stage ?? 'run',
      output,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });
  } catch (error) {
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Compiler failed.',
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

app.post('/api/ai', async (req, res) => {
  const apiKey = process.env.NVIDIA_API_KEY;
  const question = String(req.body?.question ?? '').trim();
  const language = String(req.body?.language ?? '');
  const code = String(req.body?.code ?? '');
  const output = String(req.body?.output ?? '');

  if (!apiKey) {
    return res.status(500).json({ message: 'NVIDIA_API_KEY is not configured.' });
  }

  if (!question) {
    return res.status(400).json({ message: 'Ask a question first.' });
  }

  try {
    const response = await fetch(nvidiaBaseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: nvidiaModel,
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          {
            role: 'user',
            content: [
              'You are Locom AI, a coding tutor inside a local compiler for Python and C++.',
              'Use the user code, language, and compiler output as context.',
              'Be helpful and a little flexible: prefer concise hints and debugging steps first, but include small snippets or examples when they make the explanation clearer.',
              'If the user asks for a hint, keep it short and avoid giving the entire finished program.',
              'You may point out the exact bug, explain the fix, or show a tiny corrected line/block if that is the most useful response.',
              'Do not dump a complete final solution unless the user asks for the solution, full code, final answer, or clearly wants the full implementation.',
              'If they ask for a solution, provide correct code and a short explanation.',
              `Language: ${language || 'unknown'}`,
              'Current code:',
              code || '(empty)',
              'Current output:',
              output || '(no output yet)',
              'Question:',
              question,
            ].join('\n\n'),
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        message: data?.error?.message || data?.message || `AI request failed (${response.status}).`,
      });
    }

    return res.json({
      answer: data?.choices?.[0]?.message?.content ?? 'No answer returned.',
      model: data?.model ?? nvidiaModel,
    });
  } catch (error) {
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'AI request failed.',
    });
  }
});

app.get('/api/lc/dashboard', async (req, res) => {
  try {
    const { table, rows } = await discoverProblemRows(250);
    const problems = Array.isArray(rows) ? rows.map(normalizeProblem) : [];
    const totalProblems = await fetchTableCount(table);

    return res.json({
      configured: true,
      sourceTable: table,
      stats: dashboardStatsWithTotal(problems, totalProblems),
      recentProblems: problems.slice(0, 8),
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      configured: Boolean(getSupabaseConfig()),
      message: error instanceof Error ? error.message : 'Unable to load dashboard.',
    });
  }
});

app.get('/api/lc/problems', async (req, res) => {
  try {
    const { table, rows } = await discoverProblemRows(250);
    const problems = Array.isArray(rows) ? rows.map(normalizeProblem) : [];

    return res.json({
      configured: true,
      sourceTable: table,
      problems,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      configured: Boolean(getSupabaseConfig()),
      message: error instanceof Error ? error.message : 'Unable to load LC problems.',
      problems: [],
    });
  }
});

app.get('/api/lc/problems/:problemId', async (req, res) => {
  try {
    const { table, problem } = await getProblemDetail(req.params.problemId);

    if (!problem) {
      return res.status(404).json({
        configured: true,
        sourceTable: table,
        message: 'Problem not found.',
      });
    }

    return res.json({
      configured: true,
      sourceTable: `${table} + Hugging Face details`,
      problem,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      configured: Boolean(getSupabaseConfig()),
      message: error instanceof Error ? error.message : 'Unable to load problem details.',
    });
  }
});

app.post('/api/lc/events', async (req, res) => {
  if (!supabaseEventsTable) {
    return res.json({ logged: false });
  }

  try {
    const table = safeTableName(supabaseEventsTable);
    const payload = {
      event_type: String(req.body?.eventType || 'anti_cheat_event'),
      reason: String(req.body?.reason || ''),
      language: String(req.body?.language || ''),
      created_at: new Date().toISOString(),
    };

    await supabaseRequest(table, {
      method: 'POST',
      headers: {
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });

    return res.json({ logged: true });
  } catch (error) {
    return res.status(error.status || 500).json({
      logged: false,
      message: error instanceof Error ? error.message : 'Unable to log LC event.',
    });
  }
});

if (existsSync(clientDistPath)) {
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      return next();
    }

    return res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

app.listen(port, () => {
  console.log(`locom compiler server listening on http://localhost:${port}`);
});
