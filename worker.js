/* Surge Watch — background worker: runs the Monte Carlo ensemble off the page's main thread. */
importScripts('data.js?v=7', 'model.js?v=7');
self.onmessage = e => {
  const m = e.data;
  try {
    self.SW.setStart(m.start);
    self.SW.configure(m.setup);
    self.SW.P.arrScale = m.arrScale;
    if (m.dengueMonths) self.SW.setDiseaseMonths('dengue', m.dengueMonths);
    const res = self.SW.ensembleSummary(m.state, m.now, m.hours, m.run, m.n, m.seed);
    self.postMessage({ id: m.id, res });
  } catch (err) { self.postMessage({ id: m.id, error: String(err && err.message || err) }); }
};
