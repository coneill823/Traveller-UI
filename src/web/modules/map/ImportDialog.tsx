/** Import sector or subsector data pasted or uploaded from an online generator. */
import { useMemo, useRef, useState } from 'react';
import { SUBSECTOR_LETTERS } from '../../../shared/hex';
import { PRESETS } from '../../../shared/knowledge';
import { NAME_STYLES } from '../../../shared/names';
import { parseSectorData } from '../../../shared/sectorFormats';
import { PARTY, type Sector } from '../../../shared/types';
import { act } from '../../net';
import { toast, useRules, useType } from '../../store';
import { Field, Modal, Segmented } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { fitTo } from './mapStore';

type Reveal = 'hidden' | 'detected' | 'charted';

function RevealChoice({ value, onChange }: { value: Reveal; onChange: (v: Reveal) => void }) {
  return (
    <Field label="What the party knows about these systems" hint={value === 'hidden' ? 'Players see nothing until you reveal systems.' : value === 'detected' ? 'Players see that systems exist, without names or data.' : 'Players see names and survey data, as on a public star chart.'}>
      <Segmented gm value={value} onChange={onChange} options={(Object.keys(PRESETS) as Reveal[]).map((id) => ({ id, label: PRESETS[id].label }))} />
    </Field>
  );
}

export function ImportDialog({ sector, onClose }: { sector: Sector; onClose: () => void }) {
  const systems = useType('system');
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [placement, setPlacement] = useState<'sector' | string>('auto');
  const [mode, setMode] = useState<'skip' | 'replace'>('skip');
  const [reveal, setReveal] = useState<Reveal>('hidden');
  const [useMeta, setUseMeta] = useState(true);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => parseSectorData(text), [text]);
  // Subsector-sized data defaults to a subsector slot; anything else must be a whole sector.
  const target = placement === 'auto' ? (parsed.looksLikeSubsector ? 'A' : 'sector') : placement;
  const occupied = useMemo(() => new Set(systems.filter((s) => s.sectorId === sector.id).map((s) => s.hex)), [systems, sector.id]);
  const metaCount = Object.keys(parsed.meta.subsectors).length + parsed.meta.routes.length;

  const load = async (file: File) => setText(await file.text());

  const run = async () => {
    setBusy(true);
    try {
      const res = await act<{ created: number; replaced: number; skipped: number; routes: number }>('map.import', {
        sectorId: sector.id,
        worlds: parsed.worlds,
        subsector: target === 'sector' ? undefined : target,
        mode,
        subsectorNames: useMeta && target === 'sector' ? parsed.meta.subsectors : {},
        routes: useMeta && target === 'sector' ? parsed.meta.routes : [],
        reveal: reveal === 'hidden' ? undefined : { preset: reveal, audience: PARTY },
      });
      toast(`Imported: ${res.created} new, ${res.replaced} updated, ${res.skipped} skipped${res.routes ? `, ${res.routes} routes` : ''}.`, 'ok');
      fitTo(target === 'sector' ? { kind: 'sector', id: sector.id } : { kind: 'subsector', id: sector.id, letter: target });
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  };

  return (
    <Modal
      title={`Import into ${sector.name}`}
      icon="upload"
      size="xwide"
      onClose={onClose}
      footer={
        <>
          <span className="grow small dim">{parsed.worlds.length > 0 ? `${parsed.formatLabel} · ${parsed.worlds.length} worlds` : text.trim() ? 'No worlds recognised yet' : ''}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || parsed.worlds.length === 0} onClick={() => void run()}>
            <Icon name="upload" size={13} /> Import {parsed.worlds.length || ''} worlds
          </button>
        </>
      }
    >
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.15fr)', alignItems: 'start' }}>
        <div className="col gap-12">
          <Field
            label="Sector or subsector data"
            hint="Paste the text a generator gives you, or load a file. Second Survey (tab or column) and legacy SEC files, JSON, CSV, and plain lists with a hex number and world profile on each line all work."
          >
            <textarea
              className="textarea mono"
              rows={13}
              style={{ fontSize: 11.5, whiteSpace: 'pre', overflowWrap: 'normal' }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'0101 Brannoch      C8759A9-8  S  Hi In   A  504 Na\n0103 Quill         E200000-0     Ba Va      013\n…'}
              spellCheck={false}
              autoFocus
            />
          </Field>
          <div className="row">
            <input ref={fileRef} type="file" accept=".txt,.sec,.tab,.tsv,.csv,.json,.xml,.msec,text/plain" className="hidden" onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
            <button className="btn sm" onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={12} /> Load file
            </button>
            {text && (
              <button className="btn ghost sm" onClick={() => setText('')}>
                Clear
              </button>
            )}
          </div>
          <Field label="Where the data goes" hint={target === 'sector' ? 'Hex numbers are used as they are (0101–3240).' : `Hex numbers 0101–0810 are placed inside subsector ${target}.`}>
            <select className="select" value={target} onChange={(e) => setPlacement(e.target.value)}>
              <option value="sector">Whole sector</option>
              {SUBSECTOR_LETTERS.split('').map((l) => (
                <option key={l} value={l} disabled={!parsed.looksLikeSubsector && parsed.worlds.length > 0}>
                  Subsector {l}
                  {sector.subsectors[l] ? ` – ${sector.subsectors[l]}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="If a hex already has a system">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { id: 'skip', label: 'Keep existing' },
                { id: 'replace', label: 'Update from import', title: 'Replaces survey data but keeps notes, wiki links and what players know' },
              ]}
            />
          </Field>
          <RevealChoice value={reveal} onChange={setReveal} />
          {metaCount > 0 && target === 'sector' && (
            <label className="check small">
              <input type="checkbox" checked={useMeta} onChange={(e) => setUseMeta(e.target.checked)} />
              Also apply {Object.keys(parsed.meta.subsectors).length} subsector names and {parsed.meta.routes.length} routes found in the data
            </label>
          )}
        </div>
        <div className="col">
          <h3>Preview</h3>
          {parsed.warnings.length > 0 && (
            <div className="notice warn col gap-4">
              {parsed.warnings.slice(0, 5).map((w, i) => (
                <div key={i}>{w}</div>
              ))}
              {parsed.warnings.length > 5 && <div>…and {parsed.warnings.length - 5} more.</div>}
            </div>
          )}
          {parsed.worlds.length === 0 ? (
            <div className="faint small">{text.trim() ? 'Nothing recognisable yet. Each world needs a four-digit hex number and a world profile such as C8759A9-8.' : 'Recognised worlds will be listed here before anything is saved.'}</div>
          ) : (
            <div className="scroll" style={{ maxHeight: 430, border: '1px solid var(--line)' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Hex</th>
                    <th>Name</th>
                    <th>UWP</th>
                    <th>Bases</th>
                    <th>Zone</th>
                    <th>PBG</th>
                    <th>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.worlds.slice(0, 200).map((w) => (
                    <tr key={w.hex}>
                      <td className="mono">
                        {w.hex}
                        {target === 'sector' && occupied.has(w.hex) && <span className="chip warn" style={{ marginLeft: 4 }} title="This hex already has a system">{mode === 'skip' ? 'kept' : 'update'}</span>}
                      </td>
                      <td>{w.name || <span className="faint">unnamed</span>}</td>
                      <td className="mono">{w.uwp}</td>
                      <td className="mono">{w.bases}</td>
                      <td>{w.zone === 'A' ? <span className="chip warn">A</span> : w.zone === 'R' ? <span className="chip danger">R</span> : ''}</td>
                      <td className="mono">{w.pbg}</td>
                      <td className="small dim">{w.remarks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.worlds.length > 200 && <div className="pad faint small">Showing the first 200 of {parsed.worlds.length}.</div>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function GenerateDialog({ sector, onClose }: { sector: Sector; onClose: () => void }) {
  const rules = useRules().world;
  const systems = useType('system');
  const [area, setArea] = useState('A');
  const [density, setDensity] = useState('standard');
  const [nameStyle, setNameStyle] = useState('');
  const [existing, setExisting] = useState<'fill' | 'replace'>('fill');
  const [reveal, setReveal] = useState<Reveal>('hidden');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const count = systems.filter((s) => s.sectorId === sector.id).length;

  const run = async () => {
    setBusy(true);
    try {
      const res = await act<{ created: number; seed: number }>('map.generate', {
        sectorId: sector.id,
        subsector: area === 'all' ? undefined : area,
        density,
        nameStyle: nameStyle || undefined,
        existing,
        seed: seed.trim() ? Number(seed) : undefined,
        reveal: reveal === 'hidden' ? undefined : { preset: reveal, audience: PARTY },
      });
      toast(`Generated ${res.created} systems (seed ${res.seed}).`, 'ok');
      fitTo(area === 'all' ? { kind: 'sector', id: sector.id } : { kind: 'subsector', id: sector.id, letter: area });
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  };

  return (
    <Modal
      title={`Generate systems in ${sector.name}`}
      icon="sparkles"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !rules} onClick={() => void run()}>
            <Icon name="sparkles" size={13} /> Generate
          </button>
        </>
      }
    >
      {!rules ? (
        <div className="notice warn">
          <Icon name="warning" size={14} /> World generation needs a rules pack with world-creation tables on the server.
        </div>
      ) : (
        <div className="col gap-12">
          <p className="small dim">Rolls world occurrence for every hex, then creates each mainworld with the rulebook&apos;s creation sequence. Names are placeholders you can change.</p>
          <div className="grid-2">
            <Field label="Area">
              <select className="select" value={area} onChange={(e) => setArea(e.target.value)}>
                <option value="all">Whole sector (16 subsectors)</option>
                {SUBSECTOR_LETTERS.split('').map((l) => (
                  <option key={l} value={l}>
                    Subsector {l}
                    {sector.subsectors[l] ? ` – ${sector.subsectors[l]}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Stellar density">
              <select className="select" value={density} onChange={(e) => setDensity(e.target.value)}>
                {Object.keys(rules.generation.occurrence.density).map((d) => (
                  <option key={d} value={d}>
                    {d[0].toUpperCase() + d.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name style">
              <select className="select" value={nameStyle} onChange={(e) => setNameStyle(e.target.value)}>
                <option value="">Mixed</option>
                {NAME_STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Seed (optional)" hint="The same seed gives the same result.">
              <input className="input mono" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))} placeholder="random" />
            </Field>
          </div>
          {count > 0 && (
            <Field label="Systems already in the area">
              <Segmented
                value={existing}
                onChange={setExisting}
                options={[
                  { id: 'fill', label: 'Keep them, fill empty hexes' },
                  { id: 'replace', label: 'Replace them' },
                ]}
              />
            </Field>
          )}
          <RevealChoice value={reveal} onChange={setReveal} />
        </div>
      )}
    </Modal>
  );
}
