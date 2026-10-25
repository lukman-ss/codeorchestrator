# Contributing to Coding Orchestrator

Contributions are welcome. Please adhere to these guidelines to ensure quality, security, and reproducibility.

## Prerequisites

- Node.js 24.x or higher
- Git 2.30+
- OpenCode CLI (`opencode`) available in `$PATH` (for runtime execution)

## Local Setup

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd coding-orchestrator
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your local development parameters
   ```

## Development Workflow

### Running Tests

Execute the automated test suite:
```bash
npm test
```

### Pre-Commit Security Checks

All contributions must pass the local security scanner before submission:
```bash
./scripts/security-check.sh
```

### Full Pre-Release Validation

Run the combined release gate to ensure tests, security scans, and documentation links are clean:
```bash
./scripts/public-release-check.sh
```

## Pull Request Guidelines

1. **No Credentials**: Never commit API keys, `.env` files, sqlite databases, or local home directory paths.
2. **Minimal Diff**: Write the minimal code required to solve the problem. Avoid speculative abstractions.
3. **Test Coverage**: Accompany all non-trivial bugfixes or features with automated tests.
4. **Documentation**: Update corresponding `docs/` files for any behavioral or API changes.
