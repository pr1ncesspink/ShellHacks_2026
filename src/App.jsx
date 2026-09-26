import { useEffect, useState } from 'react'
import './App.css'

const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, options)
  if (!response.ok) throw new Error(`Request failed (${response.status}). Check that FastAPI is running on port 8000 and try again.`)
  return response.json()
}

function Score({ value }) {
  const position = ((value + 1) / 2) * 100
  return <div className="score"><strong>{value.toFixed(4)}</strong><div className="score-track"><span style={{ width: `${position}%` }} /></div></div>
}

export default function App() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [search, setSearch] = useState('')
  const [minimum, setMinimum] = useState('-1')
  const [sort, setSort] = useState('desc')
  const [textA, setTextA] = useState('')
  const [textB, setTextB] = useState('')
  const [comparison, setComparison] = useState(null)
  const [comparing, setComparing] = useState(false)
  const [compareError, setCompareError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    request('/overlaps/similarity', { signal: controller.signal })
      .then(data => {
        if (!Array.isArray(data) || data.some(row => !Number.isFinite(row.name_similarity))) throw new Error('The API returned an unexpected scores response.')
        setRows(data)
      })
      .catch(err => {
        if (err.name !== 'AbortError') setError(err.message === 'Failed to fetch' ? 'Cannot reach the API. Start FastAPI on port 8000, then retry.' : err.message)
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload])

  function refresh() {
    setLoading(true)
    setError('')
    setRows([])
    setReload(value => value + 1)
  }

  async function compare(event) {
    event.preventDefault()
    setComparing(true)
    setCompareError('')
    setComparison(null)
    try {
      const data = await request('/similarity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text_a: textA.trim(), text_b: textB.trim() }),
      })
      if (!Number.isFinite(data.score)) throw new Error('The API returned an invalid score.')
      setComparison(data.score)
    } catch (err) {
      setCompareError(err.message === 'Failed to fetch' ? 'Cannot reach the API. Check that FastAPI is running.' : err.message)
    } finally { setComparing(false) }
  }

  const visible = rows.filter(row => row.name_similarity >= Number(minimum) &&
    [row.overlap_id, row.project_name_a, row.project_name_b, row.utility_a, row.utility_b].some(value => String(value).toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => sort === 'desc' ? b.name_similarity - a.name_similarity : a.name_similarity - b.name_similarity)
  const average = rows.length ? rows.reduce((sum, row) => sum + row.name_similarity, 0) / rows.length : null
  const highest = rows.length ? rows.reduce((best, row) => Math.max(best, row.name_similarity), -1) : null

  return (
    <div className="app-shell">
      <header className="topbar"><a className="brand" href="/"><span className="brand-icon"><img src="/gridlens-network.svg?v=alternating-3" alt="" /></span> Grid<span className="brand-light">Lens</span></a><span className="workspace-label">SHELLHACKS 2026 <span className="divider">/</span> MODEL EXPLORER</span></header>
      <main>
        <section className="page-heading"><div><p className="eyebrow">PROJECT INTELLIGENCE</p><h1>Find the connection.</h1><p>Explore how closely your project names match.</p></div><span className={`status ${error ? 'offline' : ''}`}><span />{loading ? 'Loading scores' : error ? 'API unavailable' : 'Scores loaded'}</span></section>
        <section className="metrics" aria-label="Score summary">
          <article><span>Project pairs</span><strong>{loading || error ? '—' : rows.length.toLocaleString()}</strong><small>From your overlap dataset</small></article>
          <article><span>Average similarity</span><strong>{average === null ? '—' : average.toFixed(4)}</strong><small>Across all project pairs</small></article>
          <article><span>Highest similarity</span><strong>{highest === null ? '—' : highest.toFixed(4)}</strong><small>Closest semantic match</small></article>
        </section>
        <div className="content-grid">
          <section className="panel results"><div className="panel-heading"><div><h2>Model scores</h2><p>Project name similarity, ranked for review.</p></div><button className="secondary" onClick={refresh} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button></div>
            <div className="filters"><label className="search-label"><span className="sr-only">Search projects or utilities</span><input type="search" placeholder="Search projects or utilities…" value={search} onChange={e => setSearch(e.target.value)} /></label><label>Min. score<select value={minimum} onChange={e => setMinimum(e.target.value)}><option value="-1">All scores</option><option value="0.5">0.50+</option><option value="0.7">0.70+</option><option value="0.9">0.90+</option></select></label><label>Sort<select value={sort} onChange={e => setSort(e.target.value)}><option value="desc">Highest first</option><option value="asc">Lowest first</option></select></label></div>
            {loading ? <div className="empty" role="status"><div className="loader" /><h3>Calculating connections…</h3><p>The first request may take longer while the model loads.</p></div> : error ? <div className="empty error" role="alert"><h3>Couldn’t load scores</h3><p>{error}</p><button className="secondary" onClick={refresh}>Try again</button></div> : visible.length === 0 ? <div className="empty"><h3>{rows.length ? 'No matching projects' : 'No scores yet'}</h3><p>{rows.length ? 'Try a different search or lower the minimum score.' : 'Add project pairs to the backend dataset, then refresh.'}</p></div> : <div className="table-wrap"><table><thead><tr><th>Project pair</th><th>Distance</th><th>Time gap</th><th>Similarity</th></tr></thead><tbody>{visible.map(row => <tr key={row.overlap_id}><td><span className="pair-id">{row.overlap_id}</span><div className="project"><strong>{row.project_name_a}</strong><small>{row.utility_a}</small></div><span className="pair-link">↕</span><div className="project"><strong>{row.project_name_b}</strong><small>{row.utility_b}</small></div></td><td className="number">{row.distance_mi.toFixed(2)}<small>miles</small></td><td className="number">{row['time_gap (day)'] ?? row.time_gap_days}<small>days</small></td><td><Score value={row.name_similarity} /></td></tr>)}</tbody></table></div>}
            <div className="table-footer">{loading || error ? 'Waiting for model results' : `${visible.length} of ${rows.length} pairs`}<span>Cosine similarity · −1 to 1</span></div>
          </section>
          <aside><section className="panel compare"><span className="eyebrow">TRY IT YOURSELF</span><h2>Compare two names</h2><p>Run a new pair through the model.</p><form onSubmit={compare}><label htmlFor="text-a">Project A</label><textarea id="text-a" placeholder="Enter the first project name" maxLength={512} required disabled={comparing} value={textA} onChange={e => { setTextA(e.target.value); setComparison(null) }} /><label htmlFor="text-b">Project B</label><textarea id="text-b" placeholder="Enter the second project name" maxLength={512} required disabled={comparing} value={textB} onChange={e => { setTextB(e.target.value); setComparison(null) }} /><button className="primary" disabled={comparing || !textA.trim() || !textB.trim()}>{comparing ? 'Comparing…' : 'Compare names →'}</button></form><div aria-live="polite">{comparison !== null && <div className="comparison-result"><span>Similarity score</span><Score value={comparison} /></div>}{compareError && <p className="inline-error" role="alert">{compareError}</p>}</div></section>
          <section className="explanation"><span className="info-icon">i</span><h3>Reading the scores</h3><p>Scores closer to 1 indicate more similar meanings. Scores near 0 indicate little similarity; negative scores indicate opposing directions in the embedding space.</p><p>These are semantic similarity scores, not probabilities or NER entity confidence scores.</p></section></aside>
        </div>
        <footer className="page-footer"><span>GridLens</span><span>Powered by your FastAPI model service</span></footer>
      </main>
    </div>
  )
}
