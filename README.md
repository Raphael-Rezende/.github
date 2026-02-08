# AI Workflows (Codex Review)

Este repositório centraliza um workflow reutilizável de **Code Review por IA** para ser chamado por outros repositórios.

## Workflow disponível

- Reutilizável: `.github/workflows/codex-review.yml`
- Requer secret no repositório chamador: `OPENAI_API_KEY`

## Como usar em um repositório alvo

1. No repositório alvo, crie o secret:
   - **Settings → Secrets and variables → Actions → New repository secret**
   - Nome: `OPENAI_API_KEY`
   - Valor: sua chave da API OpenAI

2. Crie um workflow no repositório alvo, por exemplo `.github/workflows/ai-review.yml`:

```yaml
name: AI Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  codex-review:
    uses: <SEU_USUARIO>/<NOME_REPO>/.github/workflows/codex-review.yml@main
    permissions:
      contents: read
      pull-requests: write
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

> Substitua `<SEU_USUARIO>/<NOME_REPO>` pelo caminho deste repositório central (conta pessoal, sem dependência de organização).

## O que o workflow faz

- Faz checkout do código do PR.
- Busca a branch base e gera `pr.diff` com exclusões para arquivos gerados/irrelevantes (`dist/`, `build/`, `node_modules/`, `*.lock`).
- Executa `scripts/ai_review.mjs` (Node 20), que:
  - lê/filtra/trunca o diff;
  - chama a API da OpenAI via HTTP (`fetch`);
  - cria/atualiza um único comentário no PR com header fixo `## 🤖 AI Code Review`.
