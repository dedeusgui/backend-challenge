import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildCatalogos,
  extractEnvVars,
  extractMetrics,
  parseGitLog,
  SECTION_12_REQUIREMENTS,
  validateSection12Mapping,
  type Section12Requirement,
} from '../../../scripts/build-catalogos';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

describe('build-catalogos: funções puras', () => {
  describe('parseGitLog', () => {
    it('faz o parse de commits convencionais com escopo, sem escopo e commits de merge', () => {
      const sampleLog = [
        'a86b5b27fe37df1c9bfab17dafca6e5b2526cbfa\ta86b5b2\t2026-10-31\tfix(infra): bind published ports',
        'faf597cd68505c36aef4abce0f433416be85b2b2\tfaf597c\t2026-10-31\tdocs(api): add an OpenAPI contract',
        '0bc7612b24713f8d49b85a832aa4349d06c94427\t0bc7612\t2026-10-31\tdocs: make Portuguese README the entry point',
        '1d7bad9ee6bbc13f4e773ab29562175d28d34f51\t1d7bad9\t2026-10-31\tMerge remote-tracking branch origin/main',
      ].join('\n');

      const parsed = parseGitLog(sampleLog);

      expect(parsed).toHaveLength(4);
      expect(parsed[0]).toEqual({
        hash: 'a86b5b27fe37df1c9bfab17dafca6e5b2526cbfa',
        shortHash: 'a86b5b2',
        date: '2026-10-31',
        type: 'fix',
        scope: 'infra',
        description: 'bind published ports',
        subject: 'fix(infra): bind published ports',
      });
      expect(parsed[1]).toEqual({
        hash: 'faf597cd68505c36aef4abce0f433416be85b2b2',
        shortHash: 'faf597c',
        date: '2026-10-31',
        type: 'docs',
        scope: 'api',
        description: 'add an OpenAPI contract',
        subject: 'docs(api): add an OpenAPI contract',
      });
      expect(parsed[2]).toEqual({
        hash: '0bc7612b24713f8d49b85a832aa4349d06c94427',
        shortHash: '0bc7612',
        date: '2026-10-31',
        type: 'docs',
        scope: undefined,
        description: 'make Portuguese README the entry point',
        subject: 'docs: make Portuguese README the entry point',
      });
      expect(parsed[3]).toEqual({
        hash: '1d7bad9ee6bbc13f4e773ab29562175d28d34f51',
        shortHash: '1d7bad9',
        date: '2026-10-31',
        type: 'merge',
        scope: undefined,
        description: 'Merge remote-tracking branch origin/main',
        subject: 'Merge remote-tracking branch origin/main',
      });
    });
  });

  describe('extractEnvVars', () => {
    it('extrai variáveis com padrão, regras de validação e arquivo:linha', () => {
      const codeSnippet = [
        "const db = readRequired(env, 'DATABASE_URL');",
        "const port = readPort(env.PORT ?? '3000');",
        "const region = env.AWS_REGION ?? 'us-east-1';",
        "const timeout = positiveInteger(env, 'SQS_REQUEST_TIMEOUT_MS', 5_000);",
        'const rawUnvalidated = env.UNKNOWN_FEATURE;',
      ].join('\n');

      const vars = extractEnvVars('src/config/sample.ts', codeSnippet);

      expect(vars).toHaveLength(5);
      expect(vars[0]).toEqual({
        name: 'DATABASE_URL',
        defaultValue: undefined,
        validationRule: 'obrigatória',
        source: 'src/config/sample.ts:1',
      });
      expect(vars[1]).toEqual({
        name: 'PORT',
        defaultValue: '3000',
        validationRule: 'inteiro entre 1 e 65535',
        source: 'src/config/sample.ts:2',
      });
      expect(vars[2]).toEqual({
        name: 'AWS_REGION',
        defaultValue: 'us-east-1',
        validationRule: 'obrigatória ou sem validação explícita',
        source: 'src/config/sample.ts:3',
      });
      expect(vars[3]).toEqual({
        name: 'SQS_REQUEST_TIMEOUT_MS',
        defaultValue: '5000',
        validationRule: 'inteiro positivo',
        source: 'src/config/sample.ts:4',
      });
      expect(vars[4]).toEqual({
        name: 'UNKNOWN_FEATURE',
        defaultValue: undefined,
        validationRule: 'obrigatória ou sem validação explícita',
        source: 'src/config/sample.ts:5',
      });
    });
  });

  describe('extractMetrics', () => {
    it('extrai métricas com tipo (contador/resumo), nomes das chaves de labels e arquivo:linha', () => {
      const codeSnippet = [
        "this.metrics.increment('transactions_total', { status: outcome.transaction.status });",
        "this.metrics.observe('processing_latency_ms', elapsed);",
        'this.metrics.observe(',
        "  'outbox_lag_seconds',",
        '  (attemptAt.getTime() - message.occurredAt.getTime()) / 1000,',
        ');',
        "this.metrics.increment('concurrency_conflicts_total');",
      ].join('\n');

      const metrics = extractMetrics('src/modules/sample.ts', codeSnippet);

      expect(metrics).toHaveLength(4);
      expect(metrics[0]).toEqual({
        name: 'transactions_total',
        kind: 'contador',
        labels: ['status'],
        source: 'src/modules/sample.ts:1',
      });
      expect(metrics[1]).toEqual({
        name: 'processing_latency_ms',
        kind: 'resumo',
        labels: [],
        source: 'src/modules/sample.ts:2',
      });
      expect(metrics[2]).toEqual({
        name: 'outbox_lag_seconds',
        kind: 'resumo',
        labels: [],
        source: 'src/modules/sample.ts:3',
      });
      expect(metrics[3]).toEqual({
        name: 'concurrency_conflicts_total',
        kind: 'contador',
        labels: [],
        source: 'src/modules/sample.ts:7',
      });
    });
  });

  describe('validateSection12Mapping', () => {
    it('passa quando todos os nomes mapeados existem no conjunto extraído', () => {
      const available = new Set(['transactions_total', 'concurrency_conflicts_total']);
      const requirements: readonly Section12Requirement[] = [
        {
          id: 'tx-status',
          namePt: 'Transações por status',
          nameEn: 'Transactions by status',
          metricName: 'transactions_total',
        },
        {
          id: 'retries',
          namePt: 'Retentativas (retries)',
          nameEn: 'Retries',
          metricName: null,
        },
      ];

      expect(() => validateSection12Mapping(requirements, available)).not.toThrow();
    });

    it('falha quando um nome mapeado não existe no código', () => {
      const available = new Set(['concurrency_conflicts_total']);
      const requirements: readonly Section12Requirement[] = [
        {
          id: 'tx-status',
          namePt: 'Transações por status',
          nameEn: 'Transactions by status',
          metricName: 'metric_nao_existente_no_codigo',
        },
      ];

      expect(() => validateSection12Mapping(requirements, available)).toThrow(
        /metric_nao_existente_no_codigo/,
      );
    });
  });
});

describe('build-catalogos: geração sobre repositório real', () => {
  it('gera os catálogos pt e en e confere correspondência com §12', async () => {
    const tmpOut = await mkdtemp(join(tmpdir(), 'catalogos-test-'));
    try {
      const result = await buildCatalogos({ root: REPO_ROOT, outDir: tmpOut });

      expect(result.filesWritten.length).toBe(6);

      const catalogFiles = [
        'HISTORICO.md',
        'HISTORICO.en.md',
        'CONFIGURACAO.md',
        'CONFIGURACAO.en.md',
        'METRICAS.md',
        'METRICAS.en.md',
      ];

      for (const file of catalogFiles) {
        const fullPath = join(tmpOut, file);
        expect(existsSync(fullPath)).toBe(true);
        const content = readFileSync(fullPath, 'utf8');
        expect(content.trim().length).toBeGreaterThan(0);
        expect(content).toContain('scripts/build-catalogos.ts');
      }

      // Confere também que os arquivos versionados em docs/ existem no repositório
      const ptFiles = ['docs/HISTORICO.md', 'docs/CONFIGURACAO.md', 'docs/METRICAS.md'];
      for (const relPath of ptFiles) {
        const fullPath = resolve(REPO_ROOT, relPath);
        expect(existsSync(fullPath)).toBe(true);
      }

      const metricasPt = readFileSync(join(tmpOut, 'METRICAS.md'), 'utf8');
      for (const req of SECTION_12_REQUIREMENTS) {
        expect(metricasPt).toContain(req.namePt);
        if (req.metricName !== null) {
          expect(metricasPt).toContain('implementada');
          expect(metricasPt).toContain(req.metricName);
        } else {
          expect(metricasPt).toContain('não implementada');
        }
      }
    } finally {
      await rm(tmpOut, { recursive: true, force: true });
    }
  });
});
