import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import * as prettier from 'prettier';

/**
 * Base commit for development history review.
 * Same base as REVIEW_BASE_COMMIT in scripts/build-site.ts.
 */
export const REVIEW_BASE_COMMIT = 'f12191b';

interface CommitInfo {
  readonly hash: string;
  readonly shortHash: string;
  readonly date: string;
  readonly subject: string;
  readonly type: string;
  readonly scope?: string;
  readonly description: string;
}

interface EnvVarInfo {
  readonly name: string;
  readonly defaultValue?: string;
  readonly validationRule: string;
  readonly source: string;
}

interface MetricCallInfo {
  readonly name: string;
  readonly kind: 'contador' | 'resumo' | 'gauge';
  readonly labels: readonly string[];
  readonly source: string;
}

export interface Section12Requirement {
  readonly id: string;
  readonly namePt: string;
  readonly nameEn: string;
  readonly metricName: string | null;
}

export const SECTION_12_REQUIREMENTS: readonly Section12Requirement[] = [
  {
    id: 'transactions-by-status',
    namePt: 'Transações por status',
    nameEn: 'Transactions by status',
    metricName: 'transactions_total',
  },
  {
    id: 'duplicates-detected',
    namePt: 'Duplicatas detectadas',
    nameEn: 'Duplicates detected',
    metricName: 'idempotent_replays_total',
  },
  {
    id: 'retries',
    namePt: 'Retentativas (retries)',
    nameEn: 'Retries',
    metricName: null,
  },
  {
    id: 'dlq-messages',
    namePt: 'Mensagens em DLQ',
    nameEn: 'Messages in DLQ',
    metricName: null,
  },
  {
    id: 'lock-conflicts',
    namePt: 'Conflitos de lock',
    nameEn: 'Lock conflicts',
    metricName: 'concurrency_conflicts_total',
  },
  {
    id: 'outbox-lag',
    namePt: 'Outbox lag',
    nameEn: 'Outbox lag',
    metricName: 'outbox_lag_seconds',
  },
  {
    id: 'processing-latency',
    namePt: 'Latência de processamento',
    nameEn: 'Processing latency',
    metricName: 'processing_latency_ms',
  },
];

export function parseGitLog(rawLog: string): CommitInfo[] {
  const lines = rawLog.split('\n').filter((l) => l.trim().length > 0);
  const commits: CommitInfo[] = [];

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 4) {
      continue;
    }
    const hash = parts[0] ?? '';
    const shortHash = parts[1] ?? '';
    const date = parts[2] ?? '';
    const subject = parts.slice(3).join('\t').trim();

    const conventional = /^([a-zA-Z0-9_-]+)(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject);
    if (conventional !== null) {
      const type = conventional[1] ?? 'other';
      const scope = conventional[2];
      const description = conventional[3] ?? subject;
      commits.push({ hash, shortHash, date, subject, type, scope, description });
    } else if (subject.startsWith('Merge ')) {
      commits.push({
        hash,
        shortHash,
        date,
        subject,
        type: 'merge',
        scope: undefined,
        description: subject,
      });
    } else {
      commits.push({
        hash,
        shortHash,
        date,
        subject,
        type: 'other',
        scope: undefined,
        description: subject,
      });
    }
  }

  return commits;
}

export function extractEnvVars(filePath: string, content: string): EnvVarInfo[] {
  const lines = content.split('\n');
  const results: EnvVarInfo[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNum = index + 1;
    const line = lines[index] ?? '';
    const source = `${filePath}:${lineNum}`;

    // 1. readRequired(env, 'VAR_NAME')
    const reqMatch = /readRequired\s*\(\s*env\s*,\s*['"]([A-Z0-9_]+)['"]\s*\)/.exec(line);
    if (reqMatch !== null) {
      const name = reqMatch[1] ?? '';
      results.push({ name, defaultValue: undefined, validationRule: 'obrigatória', source });
      continue;
    }

    // 2. readPort(env.PORT ?? '3000')
    const portMatch = /readPort\s*\(\s*env\.([A-Z0-9_]+)\s*\?\?\s*['"]([^'"]+)['"]\s*\)/.exec(line);
    if (portMatch !== null) {
      const name = portMatch[1] ?? '';
      const defaultValue = portMatch[2] ?? undefined;
      results.push({
        name,
        defaultValue,
        validationRule: 'inteiro entre 1 e 65535',
        source,
      });
      continue;
    }

    // 3. positiveInteger(env, 'VAR_NAME', defaultVal)
    const posIntMatch =
      /positiveInteger\s*\(\s*env\s*,\s*['"]([A-Z0-9_]+)['"]\s*,\s*([0-9_]+)\s*\)/.exec(line);
    if (posIntMatch !== null) {
      const name = posIntMatch[1] ?? '';
      const defaultValue = (posIntMatch[2] ?? '').replace(/_/g, '');
      results.push({
        name,
        defaultValue,
        validationRule: 'inteiro positivo',
        source,
      });
      continue;
    }

    // 4. tcpPort(env, 'VAR_NAME')
    const tcpMatch = /tcpPort\s*\(\s*env\s*,\s*['"]([A-Z0-9_]+)['"]\s*\)/.exec(line);
    if (tcpMatch !== null) {
      const name = tcpMatch[1] ?? '';
      results.push({
        name,
        defaultValue: undefined,
        validationRule: 'inteiro entre 1 e 65535 (opcional)',
        source,
      });
      continue;
    }

    // 5. env.VAR ?? 'default'
    const fallbackMatch = /(?:env|process\.env)\.([A-Z0-9_]+)\s*\?\?\s*['"]([^'"]+)['"]/.exec(line);
    if (fallbackMatch !== null) {
      const name = fallbackMatch[1] ?? '';
      const defaultValue = fallbackMatch[2];
      results.push({
        name,
        defaultValue,
        validationRule: 'obrigatória ou sem validação explícita',
        source,
      });
      continue;
    }

    // 6. env.VAR?.trim() || undefined
    const trimMatch =
      /(?:env|process\.env)\.([A-Z0-9_]+)\?\.trim\(\)\s*\|\|\s*(?:undefined|null)/.exec(line);
    if (trimMatch !== null) {
      const name = trimMatch[1] ?? '';
      results.push({
        name,
        defaultValue: undefined,
        validationRule: 'obrigatória ou sem validação explícita',
        source,
      });
      continue;
    }

    // 7. const varName = (process.)env.VAR; followed by required check
    const assignMatch = /(?:const|let|var)\s+(\w+)\s*=\s*(?:process\.)?env\.([A-Z0-9_]+);?/.exec(
      line,
    );
    if (assignMatch !== null) {
      const identifier = assignMatch[1] ?? '';
      const name = assignMatch[2] ?? '';
      // Lookahead up to 3 lines for a required guard
      let isRequired = false;
      for (let j = 1; j <= 3 && index + j < lines.length; j += 1) {
        const nextLine = lines[index + j] ?? '';
        if (
          (nextLine.includes(identifier) || nextLine.includes(name)) &&
          (nextLine.includes('is required') || nextLine.includes('required'))
        ) {
          isRequired = true;
          break;
        }
      }
      results.push({
        name,
        defaultValue: undefined,
        validationRule: isRequired ? 'obrigatória' : 'obrigatória ou sem validação explícita',
        source,
      });
      continue;
    }

    // 8. General env.VAR access without patterns above
    const generalMatch = /(?:env|process\.env)\.([A-Z0-9_]+)/.exec(line);
    if (generalMatch !== null) {
      const name = generalMatch[1] ?? '';
      results.push({
        name,
        defaultValue: undefined,
        validationRule: 'obrigatória ou sem validação explícita',
        source,
      });
    }
  }

  return results;
}

function extractComposeEnvVars(
  composeContent: string,
  filePath = 'docker-compose.yml',
): EnvVarInfo[] {
  const lines = composeContent.split('\n');
  const results: EnvVarInfo[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNum = index + 1;
    const line = lines[index] ?? '';
    const source = `${filePath}:${lineNum}`;

    // Port interpolation with fallback: ${PUBLISH_HOST:-127.0.0.1}
    const interpMatch = /\$\{([A-Z0-9_]+):-([^}]+)\}/.exec(line);
    if (interpMatch !== null) {
      const name = interpMatch[1] ?? '';
      const defaultValue = interpMatch[2] ?? '';
      results.push({
        name,
        defaultValue,
        validationRule: 'opcional com fallback',
        source,
      });
      continue;
    }

    // Standard compose environment keys: KEY: value
    const envMatch = /^\s{2,}([A-Z0-9_]+):\s*(?:['"]?([^'"\n]+)['"]?)?$/.exec(line);
    if (envMatch !== null) {
      const name = envMatch[1] ?? '';
      const rawVal = envMatch[2]?.trim();
      const defaultValue = rawVal === '' || rawVal === undefined ? undefined : rawVal;
      results.push({
        name,
        defaultValue,
        validationRule: 'definida na composição',
        source,
      });
    }
  }

  return results;
}

export function extractMetrics(filePath: string, content: string): MetricCallInfo[] {
  const results: MetricCallInfo[] = [];
  const regex = /(?:this\.)?metrics\.(increment|observe|gauge)\s*\(/g;
  let match: RegExpExecArray | null = null;

  while ((match = regex.exec(content)) !== null) {
    const method = match[1] ?? '';
    const kind: 'contador' | 'resumo' | 'gauge' =
      method === 'increment' ? 'contador' : method === 'observe' ? 'resumo' : 'gauge';

    const matchIndex = match.index;
    const lineNum = content.slice(0, matchIndex).split('\n').length;
    const source = `${filePath}:${lineNum}`;

    // Find closing parenthesis
    const startArgs = matchIndex + match[0].length;
    let depth = 1;
    let endArgs = startArgs;
    while (endArgs < content.length && depth > 0) {
      const char = content[endArgs];
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      endArgs += 1;
    }

    const argsText = content.slice(startArgs, endArgs - 1);
    const nameMatch = /^\s*['"]([^'"]+)['"]/.exec(argsText);
    if (nameMatch === null) {
      continue;
    }
    const name = nameMatch[1] ?? '';

    // Extract labels if an object literal is passed
    const labels: string[] = [];
    const objMatch = /\{([^}]+)\}/.exec(argsText);
    if (objMatch !== null) {
      const inner = objMatch[1] ?? '';
      const keyRegex = /([a-zA-Z0-9_]+)\s*:/g;
      let keyMatch: RegExpExecArray | null = null;
      while ((keyMatch = keyRegex.exec(inner)) !== null) {
        const key = keyMatch[1];
        if (key !== undefined && !labels.includes(key)) {
          labels.push(key);
        }
      }
    }

    results.push({ name, kind, labels, source });
  }

  return results;
}

export function validateSection12Mapping(
  requirements: readonly Section12Requirement[],
  availableMetricNames: ReadonlySet<string>,
): void {
  for (const req of requirements) {
    if (req.metricName !== null && !availableMetricNames.has(req.metricName)) {
      throw new Error(
        `Métrica '${req.metricName}' mapeada na §12 não encontrada no código (requisito: ${req.namePt})`,
      );
    }
  }
}

function gitOutput(cwd: string, args: readonly string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

async function getSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await getSourceFiles(fullPath);
      for (const f of sub) {
        files.push(f);
      }
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      files.push(fullPath);
    }
  }
  return files;
}

interface BuildCatalogosOptions {
  root?: string;
  outDir?: string;
  commitShort?: string;
}

interface BuildCatalogosResult {
  commitShort: string;
  filesWritten: string[];
  metricsCount: number;
  envVarsCount: number;
  composeVarsCount: number;
}

export async function buildCatalogos(
  options: BuildCatalogosOptions = {},
): Promise<BuildCatalogosResult> {
  const root = options.root ?? process.cwd();
  const commitShort =
    options.commitShort ?? gitOutput(root, ['rev-parse', '--short', 'HEAD']).trim();

  // 1. Historical commits from REVIEW_BASE_COMMIT to HEAD
  const gitLogRaw = gitOutput(root, [
    'log',
    '--reverse',
    '--format=%H%x09%h%x09%ad%x09%s',
    '--date=short',
    `${REVIEW_BASE_COMMIT}..HEAD`,
  ]);
  const commits = parseGitLog(gitLogRaw);

  // Group commits by type
  const typeGroups = new Map<string, CommitInfo[]>();
  for (const commit of commits) {
    const list = typeGroups.get(commit.type) ?? [];
    list.push(commit);
    typeGroups.set(commit.type, list);
  }

  // 2. Scan environment variables in src/ and docker-compose.yml
  const srcDir = join(root, 'src');
  const srcFiles = await getSourceFiles(srcDir);
  const appEnvVars: EnvVarInfo[] = [];

  for (const absPath of srcFiles) {
    const relPath = relative(root, absPath);
    const content = await readFile(absPath, 'utf8');
    const vars = extractEnvVars(relPath, content);
    for (const v of vars) {
      appEnvVars.push(v);
    }
  }

  const composePath = join(root, 'docker-compose.yml');
  const composeContent = await readFile(composePath, 'utf8');
  const composeEnvVars = extractComposeEnvVars(composeContent, 'docker-compose.yml');

  // 3. Scan metrics in src/
  const metricCalls: MetricCallInfo[] = [];
  for (const absPath of srcFiles) {
    const relPath = relative(root, absPath);
    const content = await readFile(absPath, 'utf8');
    const metrics = extractMetrics(relPath, content);
    for (const m of metrics) {
      metricCalls.push(m);
    }
  }

  // Group metrics by name
  const metricsByName = new Map<
    string,
    { kind: 'contador' | 'resumo' | 'gauge'; labels: Set<string>; sources: string[] }
  >();
  for (const m of metricCalls) {
    const existing = metricsByName.get(m.name) ?? {
      kind: m.kind,
      labels: new Set<string>(),
      sources: [],
    };
    for (const l of m.labels) {
      existing.labels.add(l);
    }
    existing.sources.push(m.source);
    metricsByName.set(m.name, existing);
  }

  const availableMetricNames = new Set(metricsByName.keys());
  validateSection12Mapping(SECTION_12_REQUIREMENTS, availableMetricNames);

  // Render documents
  const historicoPt = renderHistoricoPt(commitShort, commits, typeGroups);
  const historicoEn = renderHistoricoEn(commitShort, commits, typeGroups);

  const configuracaoPt = renderConfiguracaoPt(commitShort, appEnvVars, composeEnvVars);
  const configuracaoEn = renderConfiguracaoEn(commitShort, appEnvVars, composeEnvVars);

  const metricasPt = renderMetricasPt(commitShort, metricCalls, metricsByName);
  const metricasEn = renderMetricasEn(commitShort, metricCalls, metricsByName);

  const outDir = options.outDir ?? join(root, 'docs');
  const targets = [
    { path: join(outDir, 'HISTORICO.md'), content: historicoPt },
    { path: join(outDir, 'HISTORICO.en.md'), content: historicoEn },
    { path: join(outDir, 'CONFIGURACAO.md'), content: configuracaoPt },
    { path: join(outDir, 'CONFIGURACAO.en.md'), content: configuracaoEn },
    { path: join(outDir, 'METRICAS.md'), content: metricasPt },
    { path: join(outDir, 'METRICAS.en.md'), content: metricasEn },
  ];

  for (const target of targets) {
    const formatted = await prettier.format(target.content, {
      parser: 'markdown',
      printWidth: 100,
    });
    await writeFile(target.path, formatted, 'utf8');
  }

  return {
    commitShort,
    filesWritten: targets.map((t) => relative(root, t.path)),
    metricsCount: metricsByName.size,
    envVarsCount: appEnvVars.length,
    composeVarsCount: composeEnvVars.length,
  };
}

function renderHistoricoPt(
  commitShort: string,
  commits: readonly CommitInfo[],
  typeGroups: ReadonlyMap<string, readonly CommitInfo[]>,
): string {
  const lines: string[] = [
    `Gerado por scripts/build-catalogos.ts a partir do commit ${commitShort}. Não edite à mão; rode \`bun run docs:catalogos\`.`,
    '',
    '# Histórico de desenvolvimento',
    '',
    'Cada fatia é um commit de implementação com seu teste; os commits de documentação seguem o mesmo ciclo.',
    '',
    `Histórico com ${commits.length} commits desde o commit base \`${REVIEW_BASE_COMMIT}\` até \`${commitShort}\`. Origem: \`git log --reverse ${REVIEW_BASE_COMMIT}..HEAD\`.`,
    '',
    '## Resumo por tipo',
    '',
    '| Tipo | Quantidade |',
    '| :--- | ---------: |',
  ];

  const sortedTypes = Array.from(typeGroups.keys()).sort();
  for (const type of sortedTypes) {
    const count = typeGroups.get(type)?.length ?? 0;
    lines.push(`| ${type} | ${count} |`);
  }

  lines.push('', '## Commits por tipo');

  for (const type of sortedTypes) {
    const group = typeGroups.get(type) ?? [];
    lines.push(
      '',
      `### ${type} (${group.length} commit${group.length === 1 ? '' : 's'})`,
      '',
      '| Data | Hash | Escopo | Assunto |',
      '| :--- | :--- | :--- | :--- |',
    );
    for (const c of group) {
      lines.push(
        `| ${c.date} | \`${c.shortHash}\` | ${c.scope ?? '-'} | ${escapeCell(c.subject)} |`,
      );
    }
  }

  lines.push(
    '',
    '## Todos os commits em ordem cronológica',
    '',
    '| Data | Hash | Tipo | Escopo | Assunto |',
    '| :--- | :--- | :--- | :--- | :--- |',
  );

  for (const c of commits) {
    lines.push(
      `| ${c.date} | \`${c.shortHash}\` | ${c.type} | ${c.scope ?? '-'} | ${escapeCell(c.subject)} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function renderHistoricoEn(
  commitShort: string,
  commits: readonly CommitInfo[],
  typeGroups: ReadonlyMap<string, readonly CommitInfo[]>,
): string {
  const lines: string[] = [
    `Generated by scripts/build-catalogos.ts from commit ${commitShort}. Do not edit by hand; run \`bun run docs:catalogos\`.`,
    '',
    '> English reference copy. The main version, in Portuguese, is [HISTORICO.md](HISTORICO.md).',
    '',
    '# Development history',
    '',
    'Each vertical slice is an implementation commit with its test; documentation commits follow the same cycle.',
    '',
    `History with ${commits.length} commits from base commit \`${REVIEW_BASE_COMMIT}\` to \`${commitShort}\`. Source: \`git log --reverse ${REVIEW_BASE_COMMIT}..HEAD\`.`,
    '',
    '## Summary by type',
    '',
    '| Type | Count |',
    '| :--- | ----: |',
  ];

  const sortedTypes = Array.from(typeGroups.keys()).sort();
  for (const type of sortedTypes) {
    const count = typeGroups.get(type)?.length ?? 0;
    lines.push(`| ${type} | ${count} |`);
  }

  lines.push('', '## Commits by type');

  for (const type of sortedTypes) {
    const group = typeGroups.get(type) ?? [];
    lines.push(
      '',
      `### ${type} (${group.length} commit${group.length === 1 ? '' : 's'})`,
      '',
      '| Date | Hash | Scope | Subject |',
      '| :--- | :--- | :--- | :--- |',
    );
    for (const c of group) {
      lines.push(
        `| ${c.date} | \`${c.shortHash}\` | ${c.scope ?? '-'} | ${escapeCell(c.subject)} |`,
      );
    }
  }

  lines.push(
    '',
    '## All commits in chronological order',
    '',
    '| Date | Hash | Type | Scope | Subject |',
    '| :--- | :--- | :--- | :--- | :--- |',
  );

  for (const c of commits) {
    lines.push(
      `| ${c.date} | \`${c.shortHash}\` | ${c.type} | ${c.scope ?? '-'} | ${escapeCell(c.subject)} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function renderConfiguracaoPt(
  commitShort: string,
  appVars: readonly EnvVarInfo[],
  composeVars: readonly EnvVarInfo[],
): string {
  const lines: string[] = [
    `Gerado por scripts/build-catalogos.ts a partir do commit ${commitShort}. Não edite à mão; rode \`bun run docs:catalogos\`.`,
    '',
    '# Catálogo de configuração',
    '',
    'Variáveis de ambiente lidas pelo código da aplicação em `src/` e definidas na composição de serviços em `docker-compose.yml`.',
    '',
    '## Variáveis da aplicação (`src/`)',
    '',
    `Origem: varredura estática de \`src/\`. Total: ${appVars.length} leituras encontradas.`,
    '',
    '| Variável | Valor padrão | Regra de validação | Arquivo:linha |',
    '| :--- | :--- | :--- | :--- |',
  ];

  for (const v of appVars) {
    lines.push(
      `| \`${v.name}\` | ${v.defaultValue !== undefined ? `\`${v.defaultValue}\`` : '-'} | ${v.validationRule} | \`${v.source}\` |`,
    );
  }

  lines.push(
    '',
    '## Variáveis do Compose (`docker-compose.yml`)',
    '',
    `Origem: \`docker-compose.yml\`. Total: ${composeVars.length} variáveis encontradas.`,
    '',
    '| Variável | Valor padrão | Regra de validação | Arquivo:linha |',
    '| :--- | :--- | :--- | :--- |',
  );

  for (const v of composeVars) {
    lines.push(
      `| \`${v.name}\` | ${v.defaultValue !== undefined ? `\`${v.defaultValue}\`` : '-'} | ${v.validationRule} | \`${v.source}\` |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function renderConfiguracaoEn(
  commitShort: string,
  appVars: readonly EnvVarInfo[],
  composeVars: readonly EnvVarInfo[],
): string {
  const lines: string[] = [
    `Generated by scripts/build-catalogos.ts from commit ${commitShort}. Do not edit by hand; run \`bun run docs:catalogos\`.`,
    '',
    '> English reference copy. The main version, in Portuguese, is [CONFIGURACAO.md](CONFIGURACAO.md).',
    '',
    '# Configuration catalog',
    '',
    'Environment variables read by application code in `src/` and defined in service composition in `docker-compose.yml`.',
    '',
    '## Application variables (`src/`)',
    '',
    `Source: static scan of \`src/\`. Total: ${appVars.length} readings found.`,
    '',
    '| Variable | Default value | Validation rule | File:line |',
    '| :--- | :--- | :--- | :--- |',
  ];

  for (const v of appVars) {
    const enRule = translateValidationRule(v.validationRule);
    lines.push(
      `| \`${v.name}\` | ${v.defaultValue !== undefined ? `\`${v.defaultValue}\`` : '-'} | ${enRule} | \`${v.source}\` |`,
    );
  }

  lines.push(
    '',
    '## Compose variables (`docker-compose.yml`)',
    '',
    `Source: \`docker-compose.yml\`. Total: ${composeVars.length} variables found.`,
    '',
    '| Variable | Default value | Validation rule | File:line |',
    '| :--- | :--- | :--- | :--- |',
  );

  for (const v of composeVars) {
    const enRule = translateValidationRule(v.validationRule);
    lines.push(
      `| \`${v.name}\` | ${v.defaultValue !== undefined ? `\`${v.defaultValue}\`` : '-'} | ${enRule} | \`${v.source}\` |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function renderMetricasPt(
  commitShort: string,
  metricCalls: readonly MetricCallInfo[],
  metricsByName: ReadonlyMap<
    string,
    { kind: 'contador' | 'resumo' | 'gauge'; labels: Set<string>; sources: string[] }
  >,
): string {
  const implementedCount = SECTION_12_REQUIREMENTS.filter((r) => r.metricName !== null).length;
  const unimplementedCount = SECTION_12_REQUIREMENTS.length - implementedCount;

  const lines: string[] = [
    `Gerado por scripts/build-catalogos.ts a partir do commit ${commitShort}. Não edite à mão; rode \`bun run docs:catalogos\`.`,
    '',
    '# Catálogo de métricas',
    '',
    'Métricas emitidas pela aplicação em `src/` e correspondência com a §12 do enunciado.',
    '',
    '## Correspondência com a §12 do enunciado',
    '',
    `Origem: mapeamento com os requisitos da §12 de \`docs/CHALLENGE.md\`. Total de requisitos: ${SECTION_12_REQUIREMENTS.length} (${implementedCount} implementados, ${unimplementedCount} não implementados).`,
    '',
    '| Requisito (§12) | Status | Métrica correspondente |',
    '| :--- | :--- | :--- |',
  ];

  for (const req of SECTION_12_REQUIREMENTS) {
    const status = req.metricName !== null ? 'implementada' : 'não implementada';
    const metricCell = req.metricName !== null ? `\`${req.metricName}\`` : '-';
    lines.push(`| ${req.namePt} | ${status} | ${metricCell} |`);
  }

  lines.push(
    '',
    '## Todas as métricas da aplicação',
    '',
    `Origem: varredura estática de \`src/\`. Total: ${metricCalls.length} chamadas de métricas encontradas (${metricsByName.size} métricas distintas).`,
    '',
    '| Métrica | Tipo | Labels | Arquivo:linha |',
    '| :--- | :--- | :--- | :--- |',
  );

  const sortedNames = Array.from(metricsByName.keys()).sort();
  for (const name of sortedNames) {
    const info = metricsByName.get(name);
    if (info === undefined) {
      continue;
    }
    const labelStr =
      info.labels.size > 0
        ? Array.from(info.labels)
            .sort()
            .map((l) => `\`${l}\``)
            .join(', ')
        : '-';
    const sourceStr = info.sources.map((s) => `\`${s}\``).join(', ');
    lines.push(`| \`${name}\` | ${info.kind} | ${labelStr} | ${sourceStr} |`);
  }

  lines.push('');
  return lines.join('\n');
}

function renderMetricasEn(
  commitShort: string,
  metricCalls: readonly MetricCallInfo[],
  metricsByName: ReadonlyMap<
    string,
    { kind: 'contador' | 'resumo' | 'gauge'; labels: Set<string>; sources: string[] }
  >,
): string {
  const implementedCount = SECTION_12_REQUIREMENTS.filter((r) => r.metricName !== null).length;
  const unimplementedCount = SECTION_12_REQUIREMENTS.length - implementedCount;

  const lines: string[] = [
    `Generated by scripts/build-catalogos.ts from commit ${commitShort}. Do not edit by hand; run \`bun run docs:catalogos\`.`,
    '',
    '> English reference copy. The main version, in Portuguese, is [METRICAS.md](METRICAS.md).',
    '',
    '# Metrics catalog',
    '',
    'Metrics emitted by the application in `src/` and correspondence with §12 of the challenge specification.',
    '',
    '## Correspondence with §12 of the specification',
    '',
    `Source: mapping against requirements in §12 of \`docs/CHALLENGE.md\`. Total requirements: ${SECTION_12_REQUIREMENTS.length} (${implementedCount} implemented, ${unimplementedCount} not implemented).`,
    '',
    '| Requirement (§12) | Status | Corresponding metric |',
    '| :--- | :--- | :--- |',
  ];

  for (const req of SECTION_12_REQUIREMENTS) {
    const status = req.metricName !== null ? 'implemented' : 'not implemented';
    const metricCell = req.metricName !== null ? `\`${req.metricName}\`` : '-';
    lines.push(`| ${req.nameEn} | ${status} | ${metricCell} |`);
  }

  lines.push(
    '',
    '## All application metrics',
    '',
    `Source: static scan of \`src/\`. Total: ${metricCalls.length} metric calls found (${metricsByName.size} distinct metrics).`,
    '',
    '| Metric | Type | Labels | File:line |',
    '| :--- | :--- | :--- | :--- |',
  );

  const sortedNames = Array.from(metricsByName.keys()).sort();
  for (const name of sortedNames) {
    const info = metricsByName.get(name);
    if (info === undefined) {
      continue;
    }
    const enKind =
      info.kind === 'contador' ? 'counter' : info.kind === 'resumo' ? 'summary' : 'gauge';
    const labelStr =
      info.labels.size > 0
        ? Array.from(info.labels)
            .sort()
            .map((l) => `\`${l}\``)
            .join(', ')
        : '-';
    const sourceStr = info.sources.map((s) => `\`${s}\``).join(', ');
    lines.push(`| \`${name}\` | ${enKind} | ${labelStr} | ${sourceStr} |`);
  }

  lines.push('');
  return lines.join('\n');
}

function translateValidationRule(rule: string): string {
  switch (rule) {
    case 'obrigatória':
      return 'required';
    case 'inteiro positivo':
      return 'positive integer';
    case 'inteiro entre 1 e 65535':
      return 'integer between 1 and 65535';
    case 'inteiro entre 1 e 65535 (opcional)':
      return 'integer between 1 and 65535 (optional)';
    case 'obrigatória ou sem validação explícita':
      return 'required or without explicit validation';
    case 'definida na composição':
      return 'defined in composition';
    case 'opcional com fallback':
      return 'optional with fallback';
    default:
      return rule;
  }
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  buildCatalogos({ root })
    .then((result) => {
      console.log(`Catálogos gerados a partir do commit ${result.commitShort}:`);
      for (const file of result.filesWritten) {
        console.log(` - ${file}`);
      }
      console.log(`Métricas: ${result.metricsCount} | Variáveis: ${result.envVarsCount}`);
    })
    .catch((error: unknown) => {
      console.error('Falha ao gerar catálogos:', error);
      process.exitCode = 1;
    });
}
