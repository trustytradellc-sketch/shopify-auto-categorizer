import fs from 'fs/promises';
import { randomUUID } from 'crypto';

import { loadMapping, refreshMapping, mappingPath } from './mapping.js';

function requireParam(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function readMappingFile() {
  const raw = await fs.readFile(mappingPath, 'utf-8');
  return JSON.parse(raw);
}

async function writeMappingFile(mapping) {
  await fs.writeFile(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`, 'utf-8');
  refreshMapping();
  return loadMapping();
}

export function createCommandHandler({ shopify, processor, categorizer, openai, logger }) {
  if (!shopify) throw new Error('shopify service required');
  if (!processor) throw new Error('processor required');

  const jobs = new Map();

  async function interpretPrompt(prompt) {
    if (!openai) {
      throw new Error('OPENAI_API_KEY is required to translate natural language prompts. Provide structured commands instead.');
    }

    const system = `You turn user requests into JSON commands for a Shopify automation service.
Only respond with JSON. Use the schema: {"commands":[{"action":"<action>","params":{}}],"notes":"optional context"}.
Supported actions:
- backfill {"since"?: string ISO date, "limit"?: number}
- reprocess_product {"id": number|string}
- manual_set {"id": number|string, "category_path": string, "tags"?: string[], "seo_title"?: string, "seo_description"?: string, "body_html"?: string, "replace_tags"?: boolean}
- update_seo {"id": number|string, "seo_title"?: string, "seo_description"?: string, "body_html"?: string}
- preview {"id": number|string}
- list_rules {}
- add_rule {"name"?: string, "category": string, "keywords"?: string[], "regex"?: string, "tags"?: string[], "confidence"?: number}
- remove_rule {"name"?: string, "category"?: string}
- refresh_rules {}
- job_status {"id": string}
- list_jobs {"limit"?: number}
Prefer explicit IDs. When unsure, return an explanatory notes field asking for clarification.`;

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    });

    const content = resp.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('No response from OpenAI command interpreter');
    }
    const jsonText = (content.match(/\{[\s\S]*\}/) || [content])[0];
    const parsed = JSON.parse(jsonText);
    const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
    const notes = typeof parsed.notes === 'string' ? parsed.notes : undefined;
    return { commands, notes };
  }

  async function runBackfill(params = {}) {
    const { since, limit } = params;
    const jobId = `job-${Date.now()}-${randomUUID()}`;
    const job = {
      id: jobId,
      action: 'backfill',
      status: 'running',
      since: since || null,
      limit: limit ? Number(limit) : null,
      startedAt: new Date().toISOString()
    };
    jobs.set(jobId, job);

    const runner = async () => {
      try {
        const products = await shopify.getAllProducts({ since });
        let processed = 0;
        for (const product of products) {
          if (job.limit && processed >= job.limit) break;
          await processor.processProduct(product, 'command_backfill');
          processed += 1;
        }
        job.status = 'completed';
        job.finishedAt = new Date().toISOString();
        job.result = { processed };
      } catch (error) {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.error = error?.message || 'Unknown error';
        logger?.error({ err: job.error }, 'Backfill job failed');
      }
    };

    runner();

    return { status: 'queued', jobId };
  }

  async function runReprocess(params = {}) {
    const id = requireParam(params.id, 'id');
    const product = await shopify.getProduct(id).catch(() => null);
    if (!product) {
      throw new Error(`Product ${id} not found`);
    }
    const force = params.force === undefined || params.force === null
      ? true
      : params.force === true || params.force === 'true';
    const result = await processor.processProduct(product, 'command_reprocess', { force });
    if (result?.skipped) {
      return {
        status: 'skipped',
        id: product.id,
        reason: result.reason || 'no_change'
      };
    }
    return {
      status: 'processed',
      id: product.id,
      category: result?.classification?.category_path,
      method: result?.classification?.method
    };
  }

  async function runManualSet(params = {}) {
    const id = requireParam(params.id, 'id');
    const categoryPath = requireParam(params.category_path, 'category_path');
    const tags = Array.isArray(params.tags)
      ? params.tags
      : typeof params.tags === 'string'
        ? params.tags.split(',').map(t => t.trim()).filter(Boolean)
        : [];
    const product = await shopify.getProduct(id).catch(() => null);
    if (!product) {
      throw new Error(`Product ${id} not found`);
    }
    const classification = {
      category_path: categoryPath,
      tags,
      seo_title: params.seo_title,
      seo_description: params.seo_description,
      confidence: 0.99,
      method: 'manual'
    };
    const replaceTags = params.replace_tags === true || params.replace_tags === 'true';
    const replaceSeo = params.replace_seo === true || params.replace_seo === 'true' || Boolean(params.seo_title || params.seo_description);
    const result = await processor.processProduct(product, 'command_manual', {
      classification,
      replaceTags,
      replaceSeo,
      force: true,
      body_html: params.body_html
    });
    return {
      status: 'updated',
      id: product.id,
      category: classification.category_path,
      tags: result?.tags
    };
  }

  async function runUpdateSeo(params = {}) {
    const id = requireParam(params.id, 'id');
    const payload = {};
    if (params.seo_title) {
      payload.metafields_global_title_tag = params.seo_title.slice(0, 70);
    }
    if (params.seo_description) {
      payload.metafields_global_description_tag = params.seo_description.slice(0, 320);
    }
    if (params.body_html) {
      payload.body_html = params.body_html;
    }
    if (!Object.keys(payload).length) {
      throw new Error('At least one of seo_title, seo_description or body_html must be provided');
    }
    await shopify.updateProduct(id, payload);
    if (payload.metafields_global_title_tag) {
      await shopify.setMetafield(id, 'seo_title', payload.metafields_global_title_tag);
    }
    if (payload.metafields_global_description_tag) {
      await shopify.setMetafield(id, 'seo_description', payload.metafields_global_description_tag);
    }
    return { status: 'updated', id };
  }

  async function runPreview(params = {}) {
    const id = requireParam(params.id, 'id');
    const product = await shopify.getProduct(id).catch(() => null);
    if (!product) {
      throw new Error(`Product ${id} not found`);
    }
    const classification = await categorizer.categorize(product);
    return {
      status: 'preview',
      id: product.id,
      classification
    };
  }

  async function runListRules(params = {}) {
    const mapping = await readMappingFile();
    const limit = params.limit ? Number(params.limit) : null;
    const rules = Array.isArray(mapping.rules) ? mapping.rules : [];
    return {
      status: 'rules',
      count: limit ? Math.min(limit, rules.length) : rules.length,
      rules: limit ? rules.slice(0, limit) : rules
    };
  }

  async function runAddRule(params = {}) {
    const category = requireParam(params.category, 'category');
    const mapping = await readMappingFile();
    const rules = Array.isArray(mapping.rules) ? [...mapping.rules] : [];
    const rule = {
      name: params.name || category,
      category,
      keywords: Array.isArray(params.keywords) ? params.keywords : undefined,
      regex: params.regex || undefined,
      tags: Array.isArray(params.tags) ? params.tags : undefined,
      confidence: params.confidence ? Number(params.confidence) : undefined
    };
    rules.push(rule);
    mapping.rules = rules;
    await writeMappingFile(mapping);
    return {
      status: 'rule_added',
      rule
    };
  }

  async function runRemoveRule(params = {}) {
    const mapping = await readMappingFile();
    const rules = Array.isArray(mapping.rules) ? mapping.rules : [];
    const targetName = params.name ? params.name.toLowerCase() : null;
    const targetCategory = params.category ? params.category.toLowerCase() : null;
    const filtered = rules.filter(rule => {
      const name = (rule.name || '').toLowerCase();
      const category = (rule.category || '').toLowerCase();
      if (targetName && name === targetName) return false;
      if (targetCategory && category === targetCategory) return false;
      return true;
    });
    if (filtered.length === rules.length) {
      throw new Error('No matching rule found to remove');
    }
    mapping.rules = filtered;
    await writeMappingFile(mapping);
    return { status: 'rule_removed', removed: rules.length - filtered.length };
  }

  async function runRefreshRules() {
    const mapping = refreshMapping();
    return { status: 'rules_refreshed', count: mapping.rules?.length || 0 };
  }

  function runJobStatus(params = {}) {
    const id = requireParam(params.id, 'id');
    const job = jobs.get(id);
    if (!job) {
      throw new Error(`Job ${id} not found`);
    }
    return { status: 'job_status', job };
  }

  function runListJobs(params = {}) {
    const limit = params.limit ? Number(params.limit) : 10;
    const entries = Array.from(jobs.values())
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
      .slice(0, Math.max(limit, 1));
    return { status: 'jobs', jobs: entries };
  }

  async function executeCommand(command = {}) {
    const action = command.action;
    const params = command.params || {};
    switch (action) {
      case 'backfill':
        return runBackfill(params);
      case 'reprocess_product':
        return runReprocess(params);
      case 'manual_set':
        return runManualSet(params);
      case 'update_seo':
        return runUpdateSeo(params);
      case 'preview':
        return runPreview(params);
      case 'list_rules':
        return runListRules(params);
      case 'add_rule':
        return runAddRule(params);
      case 'remove_rule':
        return runRemoveRule(params);
      case 'refresh_rules':
        return runRefreshRules(params);
      case 'job_status':
        return runJobStatus(params);
      case 'list_jobs':
        return runListJobs(params);
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  }

  async function handleCommandRequest(body = {}) {
    const { prompt, commands: explicit, dryRun } = body;
    let commands = explicit;
    let notes;
    let usedAi = false;

    if ((!commands || !Array.isArray(commands)) && prompt) {
      const interpreted = await interpretPrompt(prompt);
      commands = interpreted.commands;
      notes = interpreted.notes;
      usedAi = true;
    }

    if (!Array.isArray(commands) || !commands.length) {
      throw new Error('No commands provided');
    }

    const results = [];
    for (const command of commands) {
      try {
        if (dryRun && command.action !== 'preview' && command.action !== 'list_rules') {
          results.push({ action: command.action, skipped: true, reason: 'dry_run' });
        } else {
          const result = await executeCommand(command);
          results.push({ action: command.action, ...result });
        }
      } catch (error) {
        logger?.error({ action: command.action, err: error?.message }, 'Command execution failed');
        results.push({ action: command.action, error: error?.message || 'Unknown error' });
      }
    }

    return {
      ok: true,
      usedAi,
      notes,
      results
    };
  }

  return {
    handle: handleCommandRequest
  };
}
