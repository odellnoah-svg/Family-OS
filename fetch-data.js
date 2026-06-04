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

// ── Page IDs (for narrative content) ─────────────────────────
const PAGES = {
  tenYearTarget:  '371c57494859802dac05ec95e25766c4',
  threeYearVision:'35cc5749485980369158c210926bdaea',
}

// ── Notion API: Query database ────────────────────────────────
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

// ── Notion API: Fetch page block content ──────────────────────
async function fetchPageContent(pageId) {
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
    headers: {
      'Authorization':  `Bearer ${TOKEN}`,
      'Notion-Version': '2022-06-28',
    },
  })
  if (!res.ok) {
    console.warn(`    Warning: Could not fetch page ${pageId} (${res.status})`)
    return []
  }
  const data = await res.json()
  const blocks = []
  for (const block of (data.results || [])) {
    const type = block.type
    // Stop at a divider or a new heading — marks end of summary section
    if (type === 'divider') break
    if (type === 'heading_1' && blocks.length > 0) break
    if (type === 'heading_2' && blocks.length > 0) break
    const content = block[type]
    if (!content) continue
    const richText = content.rich_text || []
    const text = richText.map(t => t.plain_text).join('').trim()
    if (!text) continue
    blocks.push({ type, text })
    if (blocks.length >= 8) break
  }
  return blocks
}

// ── Property helpers ──────────────────────────────────────────
const nid  = id => id.replace(/-/g, '')
const tP   = (pr, k) => pr[k]?.title?.map(t => t.plain_text).join('')        || '(Untitled)'
const sP   = (pr, k) => pr[k]?.select?.name                                   || null
const stP  = (pr, k) => pr[k]?.status?.name                                   || null
const txP  = (pr, k) => pr[k]?.rich_text?.map(t => t.plain_text).join('')    || ''
const relP = (pr, k) => (pr[k]?.relation || []).map(r => nid(r.id))
const numP = (pr, k) => { const f=pr[k]; if(!f)return null; if(f.number!==undefined)return f.number; if(f.formula?.number!==undefined)return f.formula.number; return null }
const dtP  = (pr, k) => { const f=pr[k]; if(!f)return null; if(f.date?.start)return f.date.start; if(f.formula?.date?.start)return f.formula.date.start; return null }
const msP  = (pr, k) => (pr[k]?.multi_select || []).map(s => s.name)
const perP = (pr, k) => (pr[k]?.people || []).map(p => p.name).filter(Boolean)

// ── Parsers ───────────────────────────────────────────────────
function parsePillar(p) {
  return {
    id: nid(p.id), type: 'pillar',
    name:    tP(p.properties, 'Pillar Name'),
    status:  sP(p.properties, 'Status'),
    goalIds: relP(p.properties, 'Goal'),
    rockIds: relP(p.properties, 'Rock'),
  }
}
function parseGoal(p) {
  return {
    id: nid(p.id), type: 'goal',
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
    id: nid(p.id), type: 'rock',
    name:       tP(p.properties,  'Rock'),
    quarter:    sP(p.properties,  'Quarter'),
    year:       sP(p.properties,  'Year'),
    pillarIds:  relP(p.properties, 'Pillar'),
    goalIds:    relP(p.properties, 'Related Goal'),
    projectIds: relP(p.properties, 'Related Projects'),
  }
}
function parseProject(p) {
  return {
    id: nid(p.id), type: 'project',
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
    id: nid(p.id), type: 'task',
    name:       tP(p.properties,  'Task Name'),
    status:     stP(p.properties, 'Status'),
    pillar:     sP(p.properties,  'Pillar'),
    domain:     sP(p.properties,  'Domain (aka- Area)'),
    hours:      numP(p.properties, 'Estimated Hours'),
    projectIds: relP(p.properties, 'Project'),
  }
}
function parseWipTask(p) {
  return {
    id: nid(p.id), type: 'task',
    name:         tP(p.properties,  'Task Name'),
    status:       stP(p.properties, 'Status'),
    pillarIds:    relP(p.properties, 'Pillar'),
    domain:       sP(p.properties,  'Domain (aka- Area)'),
    hours:        numP(p.properties, 'Estimated Hours'),
    projectIds:   relP(p.properties, 'Project'),
    rockIds:      relP(p.properties, '90-Day Rocks'),
    person:       perP(p.properties, 'Person'),
    startDate:    dtP(p.properties,  'Auto- Start Date (Entered WIP) '),
    completeDate: dtP(p.properties,  'Auto- Completed Date (moved to done)'),
  }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('Eubanks Family OS — Notion sync starting')
  console.log(new Date().toISOString())
  console.log('')

  // Databases
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

  // WIP dashboard tasks
  console.log('  Fetching WIP dashboard tasks...')
  // Active tasks (WIP + Up Next)
  const wipActive = (await queryAll(DBS.tasks, {
    filter: { or: [
      { property: 'Status', status: { equals: 'In progress (WIP)' } },
      { property: 'Status', status: { equals: 'Up Next (Sprint Backlog)' } },
    ]}
  })).map(parseWipTask)
  // Recent Done tasks — latest 100 sorted by last edited (avoids formula field name issues)
  let wipDone = []
  try {
    const doneRes = await notionQuery(DBS.tasks, {
      filter: { property: 'Status', status: { equals: 'Done' } },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: 100
    }, null)
    wipDone = (doneRes.results || []).map(parseWipTask)
  } catch(e) { console.warn(`    Warning: Could not fetch Done tasks: ${e.message}`) }
  const wipTasks = [...wipActive, ...wipDone]
  console.log(`    ✓ ${wipActive.length} active · ${wipDone.length} recent done`)

  // Page content
  console.log('  Fetching 10-Year Target page...')
  const tenYearTarget = await fetchPageContent(PAGES.tenYearTarget)
  console.log(`    ✓ ${tenYearTarget.length} blocks`)

  console.log('  Fetching 3-Year Vision page...')
  const threeYearVision = await fetchPageContent(PAGES.threeYearVision)
  console.log(`    ✓ ${threeYearVision.length} blocks`)

  // Current quarter/year for roadmap filtering
  const now = new Date()
  const currentQuarter = 'Q' + Math.ceil((now.getMonth() + 1) / 3)
  const currentYear = now.getFullYear().toString()

  const data = {
    generated: new Date().toISOString(),
    meta: {
      currentQuarter,
      currentYear,
      tenYearTarget,
      threeYearVision,
    },
    pillars,
    goals,
    rocks,
    projects,
    tasks,
    wipTasks,
  }

  fs.writeFileSync('data.json', JSON.stringify(data, null, 2))

  console.log('')
  console.log(`✓ data.json written successfully`)
  console.log(`  Quarter: ${currentQuarter} ${currentYear}`)
  console.log(`  ${pillars.length} pillars · ${goals.length} goals · ${rocks.length} rocks · ${projects.length} projects · ${tasks.length} active tasks · ${wipTasks.length} WIP tasks`)
}

main().catch(err => {
  console.error('')
  console.error('✗ Sync failed:', err.message)
  process.exit(1)
})
