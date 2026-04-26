#!/usr/bin/env node
// PrestaShop -> Shopify product migration.
//
// Usage from theme root:
//   node migration/migrate.mjs --product-id 16              # dry-run one product
//   node migration/migrate.mjs --product-id 16 --write      # actually create in Shopify
//   node migration/migrate.mjs --all                        # dry-run all 95
//   node migration/migrate.mjs --all --limit 5 --write      # migrate first 5
//   node migration/migrate.mjs --all --write                # migrate all 95
//
// What this version handles:
//   - Title, handle, descriptionHtml, vendor, status, SEO (German content from PrestaShop language id=1)
//   - Product options (size, etc.) and variants with prices, SKU, weight
//   - Images: downloaded from PrestaShop sequentially, uploaded to Shopify's CDN
//     via stagedUploadsCreate (avoids Shopify's URL fetcher hitting PrestaShop's
//     burst rate-limit, which returns HTTP 510 on parallel image fetches).
//
// What it does NOT handle yet:
//   - Inventory quantities (separate inventorySetOnHandQuantities mutation)
//   - Categories -> collections mapping
//   - 301 redirects from old PrestaShop URLs

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
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
for (const k of ['PEPPERSHOP_API_KEY', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_STORE_DOMAIN']) {
  if (!env[k]) { console.error(`Missing ${k} in ${envPath}`); process.exit(1); }
}

const PS_BASE = 'https://cu-bubbleshop.ch/api';
const PS_KEY = env.PEPPERSHOP_API_KEY;
const SHOP = env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_API_VERSION = '2025-01';
const PS_LANG_DE = 1;
const VENDOR = 'CU-Bubbletea';
const STORE_HANDLE = 'cu-bubbletea-center';

// ─────────────────────────────────────────────────────────────
// PrestaShop client
// ─────────────────────────────────────────────────────────────
async function ps(path, params = {}) {
  const url = new URL(`${PS_BASE}/${path}`);
  url.searchParams.set('ws_key', PS_KEY);
  url.searchParams.set('output_format', 'JSON');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`PrestaShop ${path}: HTTP ${r.status}`);
  return r.json();
}

function pickLang(field, langId = PS_LANG_DE) {
  if (field == null) return '';
  if (!Array.isArray(field)) return String(field);
  return field.find(x => String(x.id) === String(langId))?.value ?? '';
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

// ─────────────────────────────────────────────────────────────
// Shopify client
// ─────────────────────────────────────────────────────────────
let _token = null;
async function shopifyToken() {
  if (_token) return _token;
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token exchange: ${JSON.stringify(j)}`);
  _token = j.access_token;
  return _token;
}

async function gql(query, variables = {}) {
  const token = await shopifyToken();
  const r = await fetch(`https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(`GraphQL errors: ${JSON.stringify(j.errors)}`);
  return j.data;
}

// ─────────────────────────────────────────────────────────────
// PS product -> Shopify ProductSetInput
// ─────────────────────────────────────────────────────────────
async function buildShopifyInput(psProductId) {
  const { product } = await ps(`products/${psProductId}`);

  const title = pickLang(product.name);
  const handle = pickLang(product.link_rewrite);
  const descriptionHtml = pickLang(product.description) || pickLang(product.description_short) || '';
  const seoTitle = pickLang(product.meta_title) || title;
  const seoDescription = pickLang(product.meta_description) || '';

  // Combinations (variants)
  const psComboRefs = asArray(product.associations?.combinations);
  const combos = [];
  for (const c of psComboRefs) {
    const r = await ps(`combinations/${c.id}`);
    combos.push(r.combination);
  }

  // Resolve option-value labels (e.g. "0.63 kg") and their parent option group (e.g. "Größe")
  const optValueIds = new Set();
  for (const combo of combos) {
    for (const ov of asArray(combo.associations?.product_option_values)) optValueIds.add(ov.id);
  }
  const optValues = {};
  for (const id of optValueIds) {
    const r = await ps(`product_option_values/${id}`);
    optValues[id] = { name: pickLang(r.product_option_value.name), groupId: r.product_option_value.id_attribute_group };
  }
  const groupIds = new Set(Object.values(optValues).map(v => v.groupId));
  const optionGroups = {};
  for (const id of groupIds) {
    const r = await ps(`product_options/${id}`);
    optionGroups[id] = pickLang(r.product_option.public_name) || pickLang(r.product_option.name) || 'Option';
  }

  // Build productOptions (axes) for Shopify
  const valuesByGroup = new Map();
  for (const v of Object.values(optValues)) {
    if (!valuesByGroup.has(v.groupId)) valuesByGroup.set(v.groupId, new Set());
    valuesByGroup.get(v.groupId).add(v.name);
  }
  const productOptions = [...valuesByGroup.entries()].map(([groupId, names]) => ({
    name: optionGroups[groupId],
    values: [...names].map(n => ({ name: n })),
  }));

  // Build variants
  let variants;
  if (combos.length > 0) {
    variants = combos.map(combo => {
      const optionValues = asArray(combo.associations?.product_option_values).map(ov => ({
        optionName: optionGroups[optValues[ov.id].groupId],
        name: optValues[ov.id].name,
      }));
      return {
        price: combo.price,
        sku: combo.reference || product.reference || '',
        optionValues,
        inventoryItem: {
          tracked: false,
          measurement: { weight: { value: parseFloat(combo.weight) || 0, unit: 'KILOGRAMS' } },
        },
      };
    });
  } else {
    // No combinations — single default variant
    variants = [{
      price: product.price || '0',
      sku: product.reference || '',
      inventoryItem: {
        tracked: false,
        measurement: { weight: { value: parseFloat(product.weight) || 0, unit: 'KILOGRAMS' } },
      },
    }];
  }

  const psImages = asArray(product.associations?.images);

  const input = {
    title,
    handle,
    descriptionHtml,
    vendor: VENDOR,
    status: product.active === '1' ? 'ACTIVE' : 'DRAFT',
    seo: { title: seoTitle, description: seoDescription },
    productOptions,
    variants,
    files: [], // populated after staged upload (write mode only)
  };
  return { input, psImages };
}

// ─────────────────────────────────────────────────────────────
// Staged upload: download from PrestaShop, push to Shopify CDN
// ─────────────────────────────────────────────────────────────
async function uploadImagesToShopify(psProductId, psImages, alt) {
  // 1. Download bytes from PrestaShop sequentially (parallel = HTTP 510)
  const downloaded = [];
  for (const img of psImages) {
    const url = `${PS_BASE}/images/products/${psProductId}/${img.id}?ws_key=${PS_KEY}`;
    const r = await fetch(url);
    if (!r.ok) {
      console.warn(`    skip image ${img.id}: PrestaShop HTTP ${r.status}`);
      continue;
    }
    const mimeType = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const bytes = Buffer.from(await r.arrayBuffer());
    downloaded.push({ id: img.id, filename: `ps-${psProductId}-${img.id}.${ext}`, mimeType, bytes });
  }
  if (downloaded.length === 0) return [];

  // 2. Ask Shopify for staged upload targets (one mutation, all files at once)
  const stagedRes = await gql(
    `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: downloaded.map(d => ({
        resource: 'IMAGE',
        filename: d.filename,
        mimeType: d.mimeType,
        fileSize: String(d.bytes.length),
        httpMethod: 'POST',
      })),
    }
  );
  const stagedErrs = stagedRes.stagedUploadsCreate.userErrors;
  if (stagedErrs.length) throw new Error(`stagedUploadsCreate: ${JSON.stringify(stagedErrs)}`);
  const targets = stagedRes.stagedUploadsCreate.stagedTargets;

  // 3. POST bytes to each staged URL (Shopify CDN, parallel is fine)
  const files = [];
  for (let i = 0; i < downloaded.length; i++) {
    const d = downloaded[i];
    const t = targets[i];
    const form = new FormData();
    for (const p of t.parameters) form.append(p.name, p.value);
    form.append('file', new Blob([d.bytes], { type: d.mimeType }), d.filename);
    const upR = await fetch(t.url, { method: 'POST', body: form });
    if (!upR.ok) {
      const body = await upR.text();
      console.warn(`    upload to staged target failed for image ${d.id}: HTTP ${upR.status} ${body.slice(0, 200)}`);
      continue;
    }
    files.push({ contentType: 'IMAGE', originalSource: t.resourceUrl, alt });
  }
  return files;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    'product-id': { type: 'string' },
    'all': { type: 'boolean' },
    'limit': { type: 'string' },
    'write': { type: 'boolean' },
  },
});

const dryRun = !values['write'];

let productIds;
if (values['all']) {
  const r = await ps('products', { display: '[id]' });
  productIds = r.products.map(p => String(p.id));
  if (values['limit']) productIds = productIds.slice(0, parseInt(values['limit']));
} else if (values['product-id']) {
  productIds = [values['product-id']];
} else {
  console.error('Specify --product-id <id> or --all (with optional --limit N).');
  console.error('Add --write to actually create in Shopify (default is dry-run).');
  process.exit(1);
}

console.log(`mode: ${dryRun ? 'DRY-RUN (no Shopify writes)' : 'WRITE'}`);
console.log(`processing ${productIds.length} product(s)`);

const PRODUCT_SET_MUTATION = `
  mutation productSet($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product { id handle status onlineStoreUrl }
      userErrors { field message code }
    }
  }
`;

let okCount = 0, errCount = 0;
for (const id of productIds) {
  try {
    console.log(`\n--- PrestaShop product ${id} ---`);
    const { input, psImages } = await buildShopifyInput(id);
    console.log(`  title: ${input.title}`);
    console.log(`  handle: ${input.handle}`);
    console.log(`  variants: ${input.variants.length}`);
    console.log(`  options: ${input.productOptions.map(o => `${o.name}(${o.values.length})`).join(', ') || '(none)'}`);
    console.log(`  images: ${psImages.length} (PrestaShop)`);

    if (dryRun) {
      console.log('  [dry-run] would call productSet with:');
      console.log(JSON.stringify(input, null, 2).split('\n').map(l => '    ' + l).join('\n'));
    } else {
      if (psImages.length > 0) {
        console.log(`  uploading ${psImages.length} image(s) to Shopify CDN...`);
        input.files = await uploadImagesToShopify(id, psImages, input.title);
        console.log(`    -> ${input.files.length}/${psImages.length} uploaded successfully`);
      }
      const data = await gql(PRODUCT_SET_MUTATION, { input });
      const errs = data.productSet.userErrors;
      if (errs.length) {
        console.error('  USER ERRORS:');
        for (const e of errs) console.error(`    ${e.field?.join('.') ?? ''}: ${e.message} (${e.code ?? ''})`);
        errCount++;
      } else {
        const p = data.productSet.product;
        const numericId = p.id.split('/').pop();
        console.log(`  ✓ created: ${p.id}`);
        console.log(`  admin URL: https://admin.shopify.com/store/${STORE_HANDLE}/products/${numericId}`);
        okCount++;
      }
    }
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    errCount++;
  }
}

console.log(`\nDone. ok=${okCount} err=${errCount} dryRun=${dryRun}`);
