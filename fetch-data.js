/**
 * Eubanks Family OS — Notion Data Fetcher
 * Runs via GitHub Actions on a schedule.
 * Writes data.json which is served by GitHub Pages.
 *
 * Requires environment variable: NOTION_TOKEN
 */

'use strict'
const fs = require('fs')

const TOKEN = process.env.NOTION_TOKEN
if (!TOKEN) {
  console.error('Error: NOTION_TOKEN environment variable is not set.')
  console.error('Add it as a secret in GitHub: Settings → Secrets → Actions → New secret')
  process.exit(1)
}

// ── Database IDs ──────────────────────────────────────────────
const DBS = {
  pillars:  '35cc5749485980068054f8f5fb7e7ca8',
  goals:    '35dc57494859804fa8d1ec0eb19f898d',
  rocks:    '35dc5749485980c9b6ddc4ee8fcd73bd',
  projects: '35ec5749485980ec9e25cfe7dddb054e',
  tasks:    '33ac5749485980b28d0beeaf4739beb1',
}

// ── Notion API ────────────────────────────────────────────────
async function notionQuery(dbId, filter, cursor) {
  const body = { page_size: 100, ...(filter || {}) }
  if (cursor) body.start_cursor = cursor

  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${TOKEN}`,
      'Content-Type':   'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Notion API error on db ${dbId}: ${err.message || res.status}`)
  }
  return res.json()
}

async function queryAll(dbId, filter) {
  let results = [], cursor = null
  do {
    const page = await notionQuery(dbId, filter, cursor)
    results = results.concat(page.results)
    cursor = page.has_more ? page.next_cursor : null
  } while (cursor)
  return results
}

// ── Property helpers ──────────────────────────────────────────
const nid  = id => id.replace(/-/g, '')
const tP   = (pr, k) => pr[k]?.title?.map(t => t.plain_text).join('')        || '(Untitled)'
const sP   = (pr, k) => pr[k]?.select?.name                                   || null
const stP  = (pr, k) => pr[k]?.status?.name                                   || null
const txP  = (pr, k) => pr[k]?.rich_text?.map(t => t.plain_text).join('')    || ''
const relP = (pr, k) => (pr[k]?.relation || []).map(r => nid(r.id))
const numP = (pr, k) => pr[k]?.number ?? null

// ── Parsers ───────────────────────────────────────────────────
function parsePillar(p) {
  return {
    id:      nid(p.id),
    type:    'pillar',
    name:    tP(p.properties, 'Pillar Name'),
    status:  sP(p.properties, 'Status'),
    goalIds: relP(p.properties, 'Goal'),
    rockIds: relP(p.properties, 'Rock'),
  }
}

function parseGoal(p) {
  return {
    id:        nid(p.id),
    type:      'goal',
    name:      tP(p.properties,  'Goal'),
    status:    sP(p.properties,  'Status'),
    horizon:   sP(p.properties,  'Goal Horizon'),
    priority:  sP(p.properties,  'Priority'),
    pillarIds: relP(p.properties, 'Pillar'),
    rockIds:   relP(p.properties, 'Related Rocks'),
  }
}

function parseRock(p) {
  return {
    id:         nid(p.id),
    type:       'rock',
    name:       tP(p.properties,  'Rock'),
    quarter:    sP(p.properties,  'Quarter'),
    year:       sP(p.properties,  'Year'),
    pillarIds:  relP(p.properties, 'Pillar'),
    goalIds:    relP(p.properties, 'Related Goal '),  // trailing space is intentional
    projectIds: relP(p.properties, 'Related Projects'),
  }
}

function parseProject(p) {
  return {
    id:         nid(p.id),
    type:       'project',
    name:       tP(p.properties,  'Project'),
    status:     sP(p.properties,  'Status'),
    nextAction: txP(p.properties, 'Next Action'),
    rockIds:    relP(p.properties, 'Related Rock'),
    goalIds:    relP(p.properties, 'Related Goal'),
    taskIds:    relP(p.properties, 'Related Tasks'),
  }
}

function parseTask(p) {
  return {
    id:         nid(p.id),
    type:       'task',
    name:       tP(p.properties,  'Task Name'),
    status:     stP(p.properties, 'Status'),
    pillar:     sP(p.properties,  'Pillar'),
    domain:     sP(p.properties,  'Domain (aka- Area)'),
    hours:      numP(p.properties, 'Estimated Hours'),
    projectIds: relP(p.properties, 'Project'),
  }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('Eubanks Family OS — Notion sync starting')
  console.log(new Date().toISOString())
  console.log('')

  console.log('  Fetching pillars...')
  const pillars = (await queryAll(DBS.pillars)).map(parsePillar)
  console.log(`    ✓ ${pillars.length} pillars`)

  console.log('  Fetching goals...')
  const goals = (await queryAll(DBS.goals)).map(parseGoal)
  console.log(`    ✓ ${goals.length} goals`)

  console.log('  Fetching rocks...')
  const rocks = (await queryAll(DBS.rocks)).map(parseRock)
  console.log(`    ✓ ${rocks.length} rocks`)

  console.log('  Fetching projects...')
  const projects = (await queryAll(DBS.projects)).map(parseProject)
  console.log(`    ✓ ${projects.length} projects`)

  console.log('  Fetching active tasks...')
  const tasks = (await queryAll(DBS.tasks, {
    filter: {
      or: [
        { property: 'Status', status: { equals: 'In progress (WIP)' } },
        { property: 'Status', status: { equals: 'Up Next (Sprint Backlog)' } },
      ]
    }
  })).map(parseTask)
  console.log(`    ✓ ${tasks.length} active tasks`)

  const data = {
    generated: new Date().toISOString(),
    pillars,
    goals,
    rocks,
    projects,
    tasks,
  }

  fs.writeFileSync('data.json', JSON.stringify(data, null, 2))

  console.log('')
  console.log(`✓ data.json written successfully`)
}

main().catch(err => {
  console.error('')
  console.error('✗ Sync failed:', err.message)
  process.exit(1)
})
