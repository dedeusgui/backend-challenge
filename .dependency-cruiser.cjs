module.exports = {
  forbidden: [
    {
      name: 'domain-no-framework',
      comment: 'Domain code stays independent from framework and cloud packages.',
      severity: 'error',
      from: { path: '^src/(modules/[^/]+/domain|shared/domain)/' },
      to: { path: '^node_modules/(@nestjs|@mikro-orm|@aws-sdk)/' },
    },
    {
      name: 'domain-no-other-layers',
      comment: 'Domain code cannot depend on application, HTTP, or infrastructure layers.',
      severity: 'error',
      from: { path: '^src/(modules/[^/]+/domain|shared/domain)/' },
      to: { path: '(^|/)(application|infrastructure|http)/' },
    },
    {
      name: 'application-no-adapters',
      comment: 'Application code cannot depend on HTTP or infrastructure adapters.',
      severity: 'error',
      from: { path: '^src/(modules/[^/]+/application|shared/application)/' },
      to: { path: '(^|/)(http|infrastructure)/' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies obscure module ownership and initialization.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
