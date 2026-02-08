#!/usr/bin/env node

import fs from 'node:fs/promises';

const REVIEW_HEADER = '## 🤖 AI Code Review';
const MAX_DIFF_LINES = 1200;
const IGNORE_PATH_PATTERNS = [
  /^dist\//,
  /^build\//,
  /^node_modules\//,
  /\.lock$/
];

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required value: ${name}`);
  }
  return value;
}

function parseRepo(repo) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repo}`);
  }
  return { owner, repo: name };
}

function shouldIgnorePath(path) {
  return IGNORE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function filterDiffContent(rawDiff) {
  const lines = rawDiff.split('\n');
  const kept = [];
  let currentFile = null;
  let skippingFile = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = match?.[2] ?? null;
      skippingFile = currentFile ? shouldIgnorePath(currentFile) : false;
    }

    if (!skippingFile) {
      kept.push(line);
    }
  }

  return kept.join('\n');
}

function truncateDiff(diff) {
  const lines = diff.split('\n');
  const truncated = lines.length > MAX_DIFF_LINES;
  const finalLines = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines;
  return {
    diff: finalLines.join('\n'),
    originalLineCount: lines.length,
    finalLineCount: finalLines.length,
    truncated
  };
}

async function callOpenAI({ apiKey, prompt, model }) {
  const endpoint = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1/responses';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const text = data?.output_text
    ?? data?.output?.flatMap((item) => item?.content ?? [])
      ?.find((entry) => entry?.type === 'output_text')?.text
    ?? data?.choices?.[0]?.message?.content;

  if (!text || typeof text !== 'string') {
    throw new Error('OpenAI API response did not contain textual output.');
  }

  return text.trim();
}

async function githubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${body}`);
  }

  return response.status === 204 ? null : response.json();
}

function buildPrompt(diff, metadata) {
  return [
    'You are a senior software engineer performing a pull request review.',
    'Keep feedback objective, concise, and practical.',
    'Focus on correctness, security, maintainability, and regressions.',
    'If information is insufficient, state assumptions explicitly.',
    'Return Markdown with exactly these sections in Portuguese:',
    '## ✅ Pontos OK',
    '## ⚠️ Problemas/Riscos',
    '## 🔧 Sugestões pequenas',
    '## 📌 Arquivos/linhas (quando possível)',
    '',
    `Repository: ${metadata.repository}`,
    `PR: #${metadata.prNumber}`,
    '',
    'Diff to review:',
    '```diff',
    diff,
    '```'
  ].join('\n');
}

async function upsertReviewComment({ owner, repo, issueNumber, token, body }) {
  const listUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const comments = await githubRequest(listUrl, token);

  const existing = comments.find((comment) =>
    typeof comment.body === 'string' && comment.body.includes(REVIEW_HEADER)
  );

  if (existing) {
    const patchUrl = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${existing.id}`;
    await githubRequest(patchUrl, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });
    console.log(`Updated existing review comment (${existing.id}).`);
    return;
  }

  const createUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  await githubRequest(createUrl, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body })
  });
  console.log('Created new review comment.');
}

async function main() {
  const diffPath = required('diff path (--diff)', getArg('--diff'));
  const githubToken = required('GITHUB_TOKEN', process.env.GITHUB_TOKEN);
  const repository = required('GITHUB_REPOSITORY', process.env.GITHUB_REPOSITORY);
  const prNumberRaw = required('PR_NUMBER', process.env.PR_NUMBER);
  const openAiApiKey = required('OPENAI_API_KEY', process.env.OPENAI_API_KEY);
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

  const prNumber = Number(prNumberRaw);
  if (Number.isNaN(prNumber)) {
    throw new Error(`Invalid PR_NUMBER: ${prNumberRaw}`);
  }

  const { owner, repo } = parseRepo(repository);

  const rawDiff = await fs.readFile(diffPath, 'utf8');
  const filteredDiff = filterDiffContent(rawDiff);
  const { diff, originalLineCount, finalLineCount, truncated } = truncateDiff(filteredDiff);

  if (!diff.trim()) {
    const emptyReview = [
      REVIEW_HEADER,
      '',
      '_Nenhuma alteração relevante para revisão automática (após filtros de arquivos gerados/lock)._'
    ].join('\n');

    await upsertReviewComment({
      owner,
      repo,
      issueNumber: prNumber,
      token: githubToken,
      body: emptyReview
    });
    return;
  }

  const prompt = buildPrompt(diff, { repository, prNumber });
  console.log(`Requesting AI review with ${finalLineCount} diff lines (original: ${originalLineCount}).`);

  const reviewText = await callOpenAI({
    apiKey: openAiApiKey,
    prompt,
    model
  });

  const noteLines = [];
  if (truncated) {
    noteLines.push(`> ℹ️ Diff truncado para ${finalLineCount} linhas (original: ${originalLineCount}) para caber no review automático.`);
  }

  const commentBody = [
    REVIEW_HEADER,
    '',
    ...noteLines,
    ...(noteLines.length ? [''] : []),
    reviewText
  ].join('\n');

  await upsertReviewComment({
    owner,
    repo,
    issueNumber: prNumber,
    token: githubToken,
    body: commentBody
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
