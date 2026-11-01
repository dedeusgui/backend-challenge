# Local load baseline

> English reference copy. The Portuguese main version is [LOAD_TEST_BASELINE.md](LOAD_TEST_BASELINE.md).
> Methodology and criteria for each step are in [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md), the automatically generated
> report of the measurement made in the cloud. This page measures the same suite on another machine, with 13 scenarios.

## What this baseline is and is not

- **It is** a reproducible measurement: the environment, method, limits, and raw records are kept in the repository, and the table comes
  from a command. It serves to compare scenarios (number of APIs, CPUs, and workers) on the same machine.
- **It is not** a target for requests per second. The prompt does not define an RPS target and evaluates the quality of the
  experiment and the honesty of the analysis (section 14 of [CHALLENGE.md](CHALLENGE.md)).
- **It is not** a comparison of improvement. The local machine and the cloud machine are different, as the environment table shows.

## Environment

| Item       | Local (this baseline)                            | Cloud ([LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md)) |
| ---------- | ------------------------------------------------ | ---------------------------------------------------- |
| Processor  | AMD Ryzen 7 7735HS, 8 cores and 16 threads (SMT) | Intel Xeon @ 2.10 GHz, 4 vCPUs                       |
| Memory     | 22 GiB                                           | 15.7 GiB                                             |
| System     | Linux 7.2.6                                      | Linux 6.18.44                                        |
| Bun        | 1.4.4                                            | 1.4.4                                                |
| Docker     | 29.9.2                                           | not recorded in the report                           |
| PostgreSQL | 17 (`postgres:17-alpine`), default configuration | 17, default configuration                            |
| LocalStack | 4.14.0, SQS                                      | 4.14, SQS                                            |

On the local machine, CPUs `n` and `n+1` (with `n` even) are threads of the same core. Therefore, a 2 CPU
stack occupies one whole core, and a 1 CPU stack shares the core with the generator.

## How to reproduce

```text
bun run infra:up
LOAD_CPUS=2 LOAD_API_PROCESSES=1 LOAD_WORKER_PROCESSES=2 \
  LOAD_RATES=10,25,50,75,100,125,150,200,300,400,500,600,800,1000,1200,1500 \
  LOAD_RESULTS_DIR=docs/load/local/apis1-workers2-cpus2 \
  LOAD_REPORT_PATH="$(mktemp)" \
  bun run test:load
bun run load:consolidate docs/load/local
```

- `LOAD_CPUS` is the number of CPUs in the stack. `LOAD_API_PROCESSES` and `LOAD_WORKER_PROCESSES` change the topology, and the
  default is the agreed one (3 APIs and 2 workers).
- `LOAD_RATES` is the ramp. The harness default stops at 400 req/s, and that is not enough for 8 CPUs; therefore the matrix
  used the list above.
- Without `LOAD_RESULTS_DIR` and `LOAD_REPORT_PATH`, the run writes to `docs/load/results/` and to
  `docs/LOAD_TEST_RESULTS.md`, which are the cloud results. Point both to another location.
- The scenario name follows `apis<A>-workers<W>-cpus<N>`. Each directory in `docs/load/local/` has a `cpus-<N>.json`,
  the raw record of the run.

## Results

Each row is one run, with the entire ramp. The headers come from the consolidator (`test/load/consolidate.ts`) and
are intentionally in English, to remain the same as in the cloud report.

| Scenario             | APIs | Workers | Stack CPUs | Agreed (req/s) | Per stack CPU (req/s) | CPU µs/req | Utilisation | API CPU % | Worker CPU % | PostgreSQL % | LocalStack % | Largest process RSS (MiB) | First failing (req/s) | Why it failed                                     |
| -------------------- | ---: | ------: | ---------: | -------------: | --------------------: | ---------: | ----------: | --------: | -----------: | -----------: | -----------: | ------------------------: | --------------------: | ------------------------------------------------- |
| apis1-workers2-cpus1 |    1 |       2 |          1 |            150 |                 150.0 |       4754 |         71% |        35 |            4 |           26 |            7 |                       287 |                   200 | p95 1887.8 ms (max 500); p99 1940.9 ms (max 1000) |
| apis1-workers2-cpus2 |    1 |       2 |          2 |            300 |                 150.0 |       5301 |         79% |        69 |            9 |           64 |           16 |                       325 |                   400 | p95 4437.0 ms (max 500); p99 4598.0 ms (max 1000) |
| apis1-workers2-cpus4 |    1 |       2 |          4 |            400 |                 100.0 |       5242 |         52% |        86 |           15 |           85 |           24 |                       288 |                   500 | p95 2448.5 ms (max 500); p99 2520.0 ms (max 1000) |
| apis1-workers2-cpus8 |    1 |       2 |          8 |            500 |                  62.5 |       4713 |         29% |        94 |           15 |          102 |           25 |                       312 |                   600 | p95 1965.3 ms (max 500); p99 1989.3 ms (max 1000) |
| apis2-workers2-cpus1 |    2 |       2 |          1 |            150 |                 150.0 |       5556 |         83% |        43 |            4 |           29 |            7 |                       257 |                   200 | p95 4789.1 ms (max 500); p99 4974.4 ms (max 1000) |
| apis2-workers2-cpus2 |    2 |       2 |          2 |            300 |                 150.0 |       6164 |         92% |        88 |            9 |           70 |           16 |                       291 |                   400 | p95 7419.4 ms (max 500); p99 7824.9 ms (max 1000) |
| apis2-workers2-cpus4 |    2 |       2 |          4 |            500 |                 125.0 |       6237 |         78% |       137 |           18 |          127 |           30 |                       273 |                   600 | p95 1365.9 ms (max 500); p99 1411.3 ms (max 1000) |
| apis2-workers2-cpus8 |    2 |       2 |          8 |            600 |                  75.0 |       5472 |         41% |       147 |           18 |          130 |           34 |                       267 |                   800 | p95 1326.2 ms (max 500); p99 1405.9 ms (max 1000) |
| apis3-workers1-cpus2 |    3 |       1 |          2 |            200 |                 100.0 |       6590 |         66% |        67 |            6 |           48 |           10 |                       223 |                   300 | p95 1083.5 ms (max 500); p99 1904.3 ms (max 1000) |
| apis3-workers2-cpus1 |    3 |       2 |          1 |            125 |                 125.0 |       6557 |         81% |        45 |            4 |           26 |            6 |                       176 |                   150 | p95 600.3 ms (max 500); p99 1348.7 ms (max 1000)  |
| apis3-workers2-cpus2 |    3 |       2 |          2 |            200 |                 100.0 |       6764 |         68% |        68 |            6 |           49 |           11 |                       260 |                   300 | p95 4415.7 ms (max 500); p99 4651.5 ms (max 1000) |
| apis3-workers2-cpus4 |    3 |       2 |          4 |            500 |                 125.0 |       6742 |         84% |       162 |           17 |          130 |           29 |                       264 |                   600 | p95 2488.8 ms (max 500); p99 2626.1 ms (max 1000) |
| apis3-workers2-cpus8 |    3 |       2 |          8 |            800 |                 100.0 |       6422 |         63% |       237 |           25 |          197 |           44 |                       276 |                  1000 | p95 8963.9 ms (max 500); p99 9299.4 ms (max 1000) |

Legend:

- **Agreed:** the highest rate of the last step that passed all the constraints in [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md),
  with 20 s steps. The ramp stops at the first step that fails.
- **CPU µs/req:** stack CPU above idle, divided by the requests answered, in the agreed step.
- **Utilisation:** net stack CPU divided by the CPUs assigned to it.
- **API, Worker, PostgreSQL, LocalStack %:** net CPU of each group in the agreed step. 100 is one whole core.
  With multiple APIs, the value is the sum of the processes.
- **Largest process RSS:** highest RSS of a process across all steps of the run, sampled every 500 ms. It is a
  floor for the actual peak.
- **First failing and Why it failed:** the first step that broke a constraint, with the reason.

## Reading the results

- **One API alone approaches one whole core.** With 1 API and 8 CPUs, the API process uses 94% of one core
  in the agreed step of 500 req/s, and the entire stack uses only 29% of the assigned CPUs. Between 4 and 8 CPUs, the agreed rate rises from 400 to
  500 req/s. This is consistent with the single-threaded Node/Bun process being the limit.
- **More APIs help when there is spare CPU, and hinder when CPU is scarce.** With 4 CPUs, 2 or 3 APIs reach 500
  req/s, compared with 400 for 1 API. With 1 and with 2 CPUs, 3 APIs are below 1 API (125 and 200, compared with 150 and 300).
- **With 3 APIs and 8 CPUs, the stack reaches 800 req/s**, with each API near 79% of one core (237% combined). It is the
  highest agreed rate in this baseline. With 2 APIs on 8 CPUs, each API is near 73%, and the agreed rate is 600.
- **One or two workers did not change the agreed rate with 2 CPUs and 3 APIs.** Both are at 200 req/s, and fail at 300. This
  reading comes from one run per side, and says nothing about other configurations.
- **The failure is abrupt.** In the agreed step, p99 was between 50 and 660 ms. At the first failing step, p95 ranges from
  600 ms to 9 s, and p99 from 1.3 s to 9.3 s. The reasons are recorded in the last column.
- **Nonlinear in the scenario with 3 APIs and 1 CPU.** p99 was 851 ms at 100 req/s and 659 ms at 125 req/s, and 75
  req/s was 56 ms. This may be noise or contention on the same CPU. This run does not distinguish between the two hypotheses.
- **Local CPU per request is between 4713 and 6764 µs.** In the cloud, the same scenarios with 3 APIs are between 6764 and
  8320 µs. The difference is due to the machine, and there is no evidence of application improvement. See the comparison section.

## Limitations

- **One run per scenario.** There is no confidence interval. A scenario may move from one side of a constraint to the other in another
  run, and a 20 s step proves only the 20 s it ran.
- **Logical CPU is not a core.** With 2, 4, and 8 CPUs, the stack occupies whole cores. With 1 CPU, the generator may run on the
  sibling thread of the stack, and that may weigh against the 1 CPU result.
- **The generator is a single process,** running on the CPUs left over. The generator lag constraint (p99 of 50 ms) is
  part of each step's approval. A lag failure appears in the "Why it failed" column.
- **Memory is sampled.** Sampling the peak every 500 ms may miss a brief peak.
- **LocalStack is not AWS SQS,** and PostgreSQL runs with the default configuration, without a replica or tuning.
- **Only the HTTP path.** The load mix goes through the API; the path through the command queue is covered by the concurrency tests,
  and is not included in this measurement.

## Harness changes for this measurement

- `LOAD_API_PROCESSES` and `LOAD_WORKER_PROCESSES` change the topology. The default remains 3 APIs and 2 workers.
- The recorded affinity of each process is now read at the end of the run. Previously, it was read right after spawning the
  workers, before `taskset` ran, and recorded the generator's affinity (for example `1-15`). The correction does not
  change the measurement, only the record. I did not check whether the cloud record for `worker-1` with 1 CPU (`1-3`) has the same
  cause.
- The report's limitations sentence no longer mentions fixed 3 APIs and 2 workers.
- The `bun run load:consolidate` consolidator generates this page's table. Validated against the published cloud records: it
  reproduces 100, 200, and 400 req/s, 8320, 7234, and 6764 µs per request, the same first failures, and the same reasons.
- The largest RSS column was added to the consolidated output.

## Side-by-side comparison with the cloud

Same topology (3 APIs, 2 workers), different machines. This is not a measure of improvement.

| Stack CPUs |                 Cloud: agreed (req/s) | Local: agreed (req/s) | Cloud: CPU µs/req | Local: CPU µs/req |
| ---------: | ------------------------------------: | --------------------: | ----------------: | ----------------: |
|          1 |                                   100 |                   125 |              8320 |              6557 |
|          2 |                                   200 |                   200 |              7234 |              6764 |
|          4 | 400 (top of the ramp, no limit found) |                   500 |              6764 |              6742 |

In the cloud, 4 CPUs reached the top of the default ramp (400 req/s) without failing, so the agreed rate of 400 is a floor, not the
limit. Here, the 4 CPU limit was 500, with failure at 600.

## Files

- `docs/load/local/<scenario>/cpus-<N>.json`: the 13 raw records for this baseline.
- `test/load/consolidate.ts` and the `load:consolidate` script in `package.json`: generate the table.
- `docs/LOAD_TEST_RESULTS.md` and `docs/load/results/`: cloud results, unchanged in this round.
