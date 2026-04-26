#!/usr/bin/env node
// Connectivity & permissions check for the PrestaShop -> Shopify migration.
// Run from the theme root:  node migration/check.mjs

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

function loadEnv(p) {
  const env = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv(envPath);
const required = [
  'PEPPERSHOP_API_KEY',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'SHOPIFY_STORE_DOMAIN',
];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in ${envPath}: ${missing.join(', ')}`);
  process.exit(1);
}

const PS_BASE = 'https://cu-bubbleshop.ch/api';
const SHOP = env.SHOPIFY_STORE_DOMAIN;

const REQUIRED_SCOPES = [
  'read_products', 'write_products',
  'read_inventory', 'write_inventory',
  'read_files', 'write_files',
  'read_publications', 'write_publications',
];

let ok = true;

// --- PrestaShop ---
console.log('[1/3] PrestaShop Webservice...');
{
  const url = `${PS_BASE}/products?display=[id]&output_format=JSON&ws_key=${env.PEPPERSHOP_API_KEY}`;
  const r = await fetch(url);
  const body = await r.json();
  const count = body.products?.length ?? 0;
  if (r.ok && count > 0) {
    console.log(`  OK — ${count} products visible`);
  } else {
    console.log(`  FAIL — HTTP ${r.status}, body: ${JSON.stringify(body).slice(0, 200)}`);
    ok = false;
  }
}

// --- Shopify token exchange ---
console.log('[2/3] Shopify token exchange (client_credentials)...');
let token = null;
let tokenScopes = '';
{
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  const body = await r.json();
  if (r.ok) {
    token = body.access_token;
    tokenScopes = body.scope || '';
    console.log(`  OK — token expires_in=${body.expires_in}s, scope="${tokenScopes || '(empty)'}"`);
  } else {
    console.log(`  FAIL — HTTP ${r.status}, body: ${JSON.stringify(body).slice(0, 200)}`);
    ok = false;
  }
}

// --- Shopify scopes & API call ---
console.log('[3/3] Shopify Admin API call (products list)...');
if (token) {
  const r = await fetch(`https://${SHOP}/admin/api/2025-01/products.json?limit=1`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  const body = await r.json();
  if (r.ok) {
    console.log(`  OK — products endpoint reachable (current count visible: ${body.products?.length ?? 0})`);
  } else {
    console.log(`  FAIL — HTTP ${r.status}, body: ${JSON.stringify(body).slice(0, 300)}`);
    ok = false;
    const have = new Set(tokenScopes.split(',').map((s) => s.trim()).filter(Boolean));
    const stillNeed = REQUIRED_SCOPES.filter((s) => !have.has(s));
    if (stillNeed.length) {
      console.log('');
      console.log('  Token is missing scopes:');
      for (const s of stillNeed) console.log(`    - ${s}`);
      console.log('  Add them on the app in the Shopify Dev Dashboard, then re-approve the install.');
    }
  }
}

console.log('');
console.log(ok ? 'All checks passed — ready to migrate.' : 'Some checks failed — fix above before running migrate.mjs.');
process.exit(ok ? 0 : 1);
