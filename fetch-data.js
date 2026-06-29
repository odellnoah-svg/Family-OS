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

// ── Habit Tracker Database IDs ───────────────────────────────
const HABIT_DBS = {
  noah:   '38ec574948598058b3b8c5b60651d0d7',
  tricia: '7dc5acf6912142b3a433ac47ab61e29b',
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

// ── Notion API: Fetch dashboard config (key: value pairs) ────
async function fetchConfigPage(pageId) {
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
    headers: {
      'Authorization':  `Bearer ${TOKEN}`,
      'Notion-Version': '2022-06-28',
    }
  })
  if (!res.ok) {
    console.warn(`    Warning: Could not fetch config page ${pageId} (${res.status})`)
    return {}
  }
  const data = await res.json()
  const config = {}
  for (const block of (data.results || [])) {
    const type = block.type
    const richText = block[type]?.rich_text || []
    const text = richText.map(t => t.plain_text).join('').trim()
    const match = text.match(/^(\w+):\s*(\d+(?:\.\d+)?)/)
    if (match) config[match[1]] = parseFloat(match[2])
  }
  return config
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
    quarters:   msP(p.properties, 'Quarter'),  // multi-select
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
    velocity:     numP(p.properties, 'Velocity '),
    startDate:    dtP(p.properties,  'Auto- Start Date (Entered WIP) '),
    completeDate: dtP(p.properties,  'Auto- Completed Date (moved to done)'),
  }
}

// ── Habit entry parser ───────────────────────────────────────
function parseHabitEntry(p) {
  const date = p.properties['Date']?.date?.start || null
  const habits = {}
  for (const [name, prop] of Object.entries(p.properties)) {
    if (prop.type === 'checkbox') habits[name] = prop.checkbox ?? false
  }
  const completed = Object.values(habits).filter(v => v).length
  const possible  = Object.keys(habits).length
  return { date, habits, completed, possible, pct: possible > 0 ? Math.round(completed / possible * 100) : 0 }
}

// ── Noah habit display order (matches Notion template sequence) ──────
const NOAH_HABIT_ORDER = [
  "5am wake",
  "Vitamins/supplements",
  "1/2 gallon water",
  "No caffeine",
  "Move!",
  "Review today's top 3 (what am i doing today)",
  "Learn (read/listen)",
  "Play with Owen",
  "Food recorded (with no unplanned indulgences)",
  "Review 3 wins from today (stay in the gain)",
  "Create top 3 priorities for tomorrow",
  "Gratitude/prayer",
  "No phone in bed",
]

// ── Habit entry builder — new structure (one row per habit per day) ──
function buildHabitEntries(rows, orderedFields = null) {
  const byDate = {}
  for (const p of rows) {
    const date = p.properties['Date']?.date?.start || null
    if (!date) continue
    const name = p.properties['Name']?.title?.[0]?.plain_text?.trim() || null
    if (!name) continue
    const checked = p.properties['Checkbox']?.checkbox ?? false
    if (!byDate[date]) byDate[date] = {}
    byDate[date][name] = checked
  }
  const allFields = new Set()
  Object.values(byDate).forEach(h => Object.keys(h).forEach(k => allFields.add(k)))
  const fields = orderedFields
    ? orderedFields.filter(f => allFields.has(f)).concat([...allFields].filter(f => !orderedFields.includes(f)).sort())
    : [...allFields].sort()
  const entries = Object.entries(byDate).map(([date, habits]) => {
    const completed = Object.values(habits).filter(v => v).length
    const possible = Object.keys(habits).length
    return { date, habits, completed, possible, pct: possible > 0 ? Math.round(completed / possible * 100) : 0 }
  }).sort((a, b) => a.date.localeCompare(b.date))
  return { fields, entries }
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
        { property: 'Status', status: { equals: 'Current Sprint (this week)' } },
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
      { property: 'Status', status: { equals: 'Current Sprint (this week)' } },
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

  // Habit tracker data (last 30 days)
  const habitThirtyAgo = new Date(Date.now() - 62*24*60*60*1000).toISOString().split('T')[0]
  console.log('  Fetching Noah habit data (new structure)...')
  const noahHabitRows = await queryAll(HABIT_DBS.noah, {
    filter: { property: 'Date', date: { on_or_after: habitThirtyAgo } },
    sorts: [{ property: 'Date', direction: 'ascending' }]
  })
  const { fields: noahFields, entries: noahHabitRaw } = buildHabitEntries(noahHabitRows, NOAH_HABIT_ORDER)
  console.log(`    ✓ ${noahHabitRaw.length} days · ${noahFields.length} habits`)

  console.log('  Fetching Tricia habit data...')
  const triciaHabitRaw = (await queryAll(HABIT_DBS.tricia, {
    filter: { property: 'Date', date: { on_or_after: habitThirtyAgo } },
    sorts: [{ property: 'Date', direction: 'ascending' }]
  })).map(parseHabitEntry).filter(e => e.date)
  console.log(`    ✓ ${triciaHabitRaw.length} entries`)

  // noahFields already set by buildHabitEntries above
  const triciaFields = triciaHabitRaw.length > 0 ? Object.keys(triciaHabitRaw[0].habits).sort() : []
  const habitData = {
    noah:   { fields: noahFields,   entries: noahHabitRaw  },
    tricia: { fields: triciaFields, entries: triciaHabitRaw },
  }

  // Dashboard config
  console.log('  Fetching dashboard config...')
  const wipTargets = await fetchConfigPage('375c574948598125 80bfd476854c912d'.replace(' ',''))
  console.log(`    ✓ ${Object.keys(wipTargets).length} config values`)

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
      wipTargets,
    },
    pillars,
    goals,
    rocks,
    projects,
    tasks,
    wipTasks,
    habitData,
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
