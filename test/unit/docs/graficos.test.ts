import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAllGraficos,
  countBlockedScenarios,
  escapeXml,
  linearScale,
  parseExperiment1Table,
  parseLoadScenario,
  renderCargaTaxaP99Svg,
  renderGateSuitesSvg,
} from '../../../scripts/build-graficos';
import { parseCheckAllLog } from '../../../scripts/record-gate';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const CHECK_ALL_SAMPLE = `
$ bun run check:fast && bun run test:infra && bun run test:integration && bun run test:concurrency && bun run test:e2e && bun run test:features
$ bun run typecheck && bun run lint && bun run format:check && bun run test:unit
$ bun test test/unit
bun test v1.4.4 (38afee6c8)

 490 pass
 0 fail
Ran 490 tests across 44 files. [6.48s]
$ bun test test/infra
bun test v1.4.4 (38afee6c8)

 4 pass
 0 fail
Ran 4 tests across 1 file. [369.00ms]
$ bun test test/integration
bun test v1.4.4 (38afee6c8)

 247 pass
 0 fail
Ran 247 tests across 12 files. [10.2s]
$ bun test test/concurrency
bun test v1.4.4 (38afee6c8)

 23 pass
 0 fail
Ran 23 tests across 2 files. [5.1s]
$ bun test test/e2e
bun test v1.4.4 (38afee6c8)

 100 pass
 0 fail
Ran 100 tests across 8 files. [8.4s]
$ bun --bun node_modules/.bin/cucumber-js --tags 'not @bloqueado' --require 'test/features/steps/**/*.ts' 'test/features/**/*.feature'
.....

73 scenarios (73 passed)
365 steps (365 passed)
0m 38.388s (0m 38.241s executing your code)
check:all exit=0
`;

const EXPERIMENT_SAMPLE = `
## Experimento 1 — triggers de concordância entre saldo e ledger

| Carga                   | Quantil | Sem triggers (mediana de 6) | Com triggers (mediana de 6) |        Diferença |
| ----------------------- | ------- | --------------------------: | --------------------------: | ---------------: |
| uma wallet, sequencial  | p50     |                     6,11 ms |                     6,21 ms | +0,10 ms (+1,6%) |
| uma wallet, sequencial  | p95     |                     8,09 ms |                     8,52 ms | +0,43 ms (+5,3%) |
| uma wallet, sequencial  | p99     |                     9,62 ms |                    10,52 ms | +0,90 ms (+9,4%) |
| 120 wallets, sequencial | p50     |                     6,12 ms |                     6,18 ms | +0,06 ms (+1,1%) |
| 120 wallets, sequencial | p95     |                     8,04 ms |                     8,21 ms | +0,17 ms (+2,1%) |
| 120 wallets, sequencial | p99     |                     9,25 ms |                     9,91 ms | +0,66 ms (+7,1%) |
| uma wallet, 8 workers   | p50     |                    39,36 ms |                    41,20 ms | +1,84 ms (+4,7%) |
| uma wallet, 8 workers   | p95     |                    50,01 ms |                    53,75 ms | +3,74 ms (+7,5%) |
| uma wallet, 8 workers   | p99     |                    65,34 ms |                    65,83 ms | +0,48 ms (+0,7%) |

## Experimento 1b — guardas de linha (migration 10)
`;

const SCENARIO_SAMPLE = JSON.stringify({
  stackCpus: 2,
  agreedRate: 100,
  firstFailingRate: 150,
  idle: {
    cpuPercent: {
      'api-1': 1.0,
      'worker-1': 0.5,
      postgres: 1.0,
    },
  },
  steps: [
    {
      rate: 50,
      elapsedSeconds: 10,
      answered: 500,
      p99: 15.2,
      cpuPercent: {
        'api-1': 10.0,
        'worker-1': 5.0,
        postgres: 10.0,
      },
    },
    {
      rate: 100,
      elapsedSeconds: 10,
      answered: 1000,
      p99: 25.4,
      cpuPercent: {
        'api-1': 25.0,
        'worker-1': 10.5,
        postgres: 20.0,
      },
    },
  ],
});

describe('Gráficos e Gate', () => {
  describe('Escape de rótulo', () => {
    test('escapa caracteres especiais de XML/HTML em strings', () => {
      const input = 'Teste <script>alert("xss")</script> & \'quote\'';
      const escaped = escapeXml(input);
      expect(escaped).toBe(
        'Teste &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &apos;quote&apos;',
      );
      expect(escaped).not.toContain('<script');
    });
  });

  describe('Escala e eixo', () => {
    test('calcula projeção linear a partir de zero', () => {
      const y0 = linearScale(0, 0, 100, 0, 200);
      const y50 = linearScale(50, 0, 100, 0, 200);
      const y100 = linearScale(100, 0, 100, 0, 200);

      expect(y0).toBe(0);
      expect(y50).toBe(100);
      expect(y100).toBe(200);
    });

    test('restringe divisão por zero retornando rangeMin', () => {
      expect(linearScale(50, 0, 0, 10, 100)).toBe(10);
    });
  });

  describe('Parser do log do check:all', () => {
    test('extrai suítes, contagens e exit code da amostra', () => {
      const gate = parseCheckAllLog(CHECK_ALL_SAMPLE);
      expect(gate.exitCode).toBe(0);
      expect(gate.passed).toBe(true);

      const unit = gate.suites.find((s) => s.key === 'unit');
      expect(unit?.passed).toBe(490);
      expect(unit?.failed).toBe(0);

      const infra = gate.suites.find((s) => s.key === 'infra');
      expect(infra?.passed).toBe(4);
      expect(infra?.failed).toBe(0);

      const integration = gate.suites.find((s) => s.key === 'integration');
      expect(integration?.passed).toBe(247);
      expect(integration?.failed).toBe(0);

      const concurrency = gate.suites.find((s) => s.key === 'concurrency');
      expect(concurrency?.passed).toBe(23);
      expect(concurrency?.failed).toBe(0);

      const e2e = gate.suites.find((s) => s.key === 'e2e');
      expect(e2e?.passed).toBe(100);
      expect(e2e?.failed).toBe(0);

      const features = gate.suites.find((s) => s.key === 'features');
      expect(features?.passed).toBe(73);
      expect(features?.failed).toBe(0);

      expect(gate.cucumber.scenarios.total).toBe(73);
      expect(gate.cucumber.scenarios.passed).toBe(73);
      expect(gate.cucumber.steps.total).toBe(365);
      expect(gate.cucumber.steps.passed).toBe(365);
    });
  });

  describe('Parser da tabela do experimento', () => {
    test('lê quantis p50, p95 e p99 para cada carga pelo cabeçalho', () => {
      const rows = parseExperiment1Table(EXPERIMENT_SAMPLE);
      expect(rows.length).toBe(9);

      const seqWalletP50 = rows.find(
        (r) => r.carga === 'uma wallet, sequencial' && r.quantil === 'p50',
      );
      expect(seqWalletP50?.semTriggersMs).toBe(6.11);
      expect(seqWalletP50?.comTriggersMs).toBe(6.21);
      expect(seqWalletP50?.diffMs).toBeCloseTo(0.1, 2);

      const concP99 = rows.find((r) => r.carga === 'uma wallet, 8 workers' && r.quantil === 'p99');
      expect(concP99?.semTriggersMs).toBe(65.34);
      expect(concP99?.comTriggersMs).toBe(65.83);
      // A tabela publica a diferença arredondada (+0,48 ms); a subtração dos valores exibidos dá +0,49 ms.
      expect(concP99?.diffMs).toBeCloseTo(0.48, 2);
    });
  });

  describe('Leitura de cenário de carga', () => {
    test('extrai taxa acordada, p99 e utilização de CPU', () => {
      const parsed = parseLoadScenario(SCENARIO_SAMPLE, 'apis1-workers2-cpus2');
      expect(parsed.scenarioName).toBe('apis1-workers2-cpus2');
      expect(parsed.agreedRate).toBe(100);
      expect(parsed.firstFailingRate).toBe(150);
      expect(parsed.p99AtAgreed).toBe(25.4);
      // gross = 25 + 10.5 + 20 = 55.5
      // net = (25-1) + (10.5-0.5) + (20-1) = 24 + 10 + 19 = 53
      // utilisation = 53 / (2 * 100) = 26.5%
      expect(parsed.cpuUtilisationPercent).toBeCloseTo(26.5, 1);
    });
  });

  describe('Geração de SVG a partir do repositório real', () => {
    test('gera os arquivos SVG no repositório com tamanho > 0 e sem <script', async () => {
      // Usa o docs/gate/ultimo-gate.json versionado. Não o regrava: o gate é gravado por gate:registrar.
      await buildAllGraficos({ repoRoot: ROOT });

      const files = [
        'docs/graficos/carga-taxa-p99.svg',
        'docs/graficos/carga-utilizacao.svg',
        'docs/graficos/gatilho-custo.svg',
        'docs/graficos/gate-suites.svg',
        'docs/graficos/selo-gate.svg',
        'docs/graficos/selo-cenarios.svg',
      ];

      for (const file of files) {
        const fullPath = join(ROOT, file);
        expect(existsSync(fullPath)).toBe(true);
        const fileStat = await stat(fullPath);
        expect(fileStat.size).toBeGreaterThan(0);
        const content = await readFile(fullPath, 'utf8');
        expect(content).not.toContain('<script');
        expect(content).toContain('<svg');
        expect(content).toContain('</svg>');
      }
    });

    test('nenhum texto de SVG ultrapassa a largura do viewBox', async () => {
      const files = [
        'docs/graficos/carga-taxa-p99.svg',
        'docs/graficos/carga-utilizacao.svg',
        'docs/graficos/gatilho-custo.svg',
        'docs/graficos/gate-suites.svg',
        'docs/graficos/selo-gate.svg',
        'docs/graficos/selo-cenarios.svg',
      ];

      const overflows: string[] = [];
      for (const file of files) {
        const content = await readFile(join(ROOT, file), 'utf8');
        const viewBoxMatch = /viewBox="0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)"/.exec(content);
        if (viewBoxMatch === null) {
          throw new Error(`SVG ${file} sem viewBox válido`);
        }
        const rawWidth = viewBoxMatch[1];
        if (rawWidth === undefined) {
          throw new Error(`SVG ${file} sem largura no viewBox`);
        }
        const viewBoxWidth = Number.parseFloat(rawWidth);

        const textRegex = /<text\b([^>]*)>(.*?)<\/text>/gs;
        let match: RegExpExecArray | null = textRegex.exec(content);
        while (match !== null) {
          const attributes = match[1] ?? '';
          const rawText = match[2] ?? '';

          const xMatch = /\bx="([\d.-]+)"/.exec(attributes);
          const fontSizeMatch = /\bfont-size="([\d.]+)"/.exec(attributes);
          const anchorMatch = /\btext-anchor="([^"]+)"/.exec(attributes);

          const rawX = xMatch?.[1];
          const rawFontSize = fontSizeMatch?.[1];
          if (rawX !== undefined && rawFontSize !== undefined) {
            const x = Number.parseFloat(rawX);
            const fontSize = Number.parseFloat(rawFontSize);
            const anchor = anchorMatch?.[1] ?? 'start';

            const cleanText = rawText
              .replace(/<[^>]+>/g, '')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'")
              .replace(/&amp;/g, '&');

            const estimatedWidth = 0.6 * fontSize * cleanText.length;
            let rightEdge: number;
            if (anchor === 'end') {
              rightEdge = x;
            } else if (anchor === 'middle') {
              rightEdge = x + estimatedWidth / 2;
            } else {
              rightEdge = x + estimatedWidth;
            }

            if (rightEdge > viewBoxWidth) {
              overflows.push(
                `${file}: "${cleanText}" (x=${x}, font-size=${fontSize}, anchor=${anchor}, estimado=${estimatedWidth.toFixed(1)}, borda-direita=${rightEdge.toFixed(1)}) ultrapassa viewBox (${viewBoxWidth})`,
              );
            }
          }
          match = textRegex.exec(content);
        }
      }

      expect(overflows).toEqual([]);
    });

    test('conta cenários marcados @bloqueado em test/features via grep', () => {
      const count = countBlockedScenarios(join(ROOT, 'test/features'));
      expect(count).toBe(2);
    });

    test('renderGateSuitesSvg formata rótulo de Gherkin com cenários e passos e adiciona nota @bloqueado', () => {
      const gate = parseCheckAllLog(CHECK_ALL_SAMPLE);
      const svg = renderGateSuitesSvg(gate, 2);
      expect(svg).toContain('73 cenários · 365 passos');
      expect(svg).not.toContain('73 passou');
      expect(svg).toContain('2 cenários marcados @bloqueado ficam fora do gate');
    });

    test('renderCargaTaxaP99Svg possui dois eixos para separar taxa e latência', () => {
      const sample = parseLoadScenario(SCENARIO_SAMPLE, 'apis1-workers2-cpus2');
      const svg = renderCargaTaxaP99Svg([sample]);
      expect(svg).toContain('Taxa acordada (req/s)');
      expect(svg).toContain('p99 (ms)');
      // Verifica presença de dois caminhos de eixo
      const axisMatches = svg.match(/<path d="M \d+\.?\d* \d+ H \d+\.?\d* M/g);
      expect(axisMatches?.length).toBe(2);
    });
  });
});
