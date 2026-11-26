/** GM dialog to create a system in a hex or edit an existing one. */
import { useMemo, useState } from 'react';
import { parseHex } from '../../../shared/hex';
import { generateName } from '../../../shared/names';
import { decodeUwp, generateWorld, tradeCodesFor } from '../../../shared/rules/world';
import type { Sector, StarSystem, TravelZone } from '../../../shared/types';
import { isValidUwp, parseUwp } from '../../../shared/uwp';
import { act } from '../../net';
import { toast, useRules, useType } from '../../store';
import { Field, Modal, Segmented } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { selectSystem } from './mapStore';

interface Props {
  /** Existing system to edit, or undefined to create. */
  system?: StarSystem;
  sector: Sector;
  hex: string;
  onClose: () => void;
}

export function SystemEditor({ system, sector, hex, onClose }: Props) {
  const rules = useRules().world;
  const sectors = useType('sector');
  const [name, setName] = useState(system?.name ?? '');
  const [uwp, setUwp] = useState(system?.uwp ?? '');
  const [bases, setBases] = useState(system?.bases ?? '');
  const [zone, setZone] = useState<TravelZone>(system?.zone ?? '');
  const [pbg, setPbg] = useState(system?.pbg ?? '');
  const [allegiance, setAllegiance] = useState(system?.allegiance ?? '');
  const [stars, setStars] = useState(system?.stars ?? '');
  const [remarks, setRemarks] = useState(system?.remarks ?? '');
  const [sectorId, setSectorId] = useState(sector.id);
  const [hexText, setHexText] = useState(hex);
  const [busy, setBusy] = useState(false);

  const uwpOk = uwp === '' || isValidUwp(uwp);
  const hexOk = parseHex(hexText) !== null;
  const pbgOk = pbg === '' || /^[0-9A-Fa-f]{3}$/.test(pbg);
  const decoded = useMemo(() => decodeUwp(uwp, rules), [uwp, rules]);
  const codes = useMemo(() => tradeCodesFor(parseUwp(uwp), rules), [uwp, rules]);

  const roll = () => {
    if (!rules) {
      toast('No rules pack with world-creation tables is installed on the server', 'error');
      return;
    }
    const w = generateWorld(rules, Math.random);
    setUwp(w.uwp);
    setBases(w.bases);
    setPbg(w.pbg);
    setZone(w.zone);
    if (!stars) setStars(w.stars);
    if (!name) setName(generateName(Math.random));
  };

  const save = async () => {
    setBusy(true);
    try {
      const fields = {
        name: name.trim() || undefined,
        uwp: uwp ? uwp.toUpperCase() : undefined,
        bases: bases.trim().toUpperCase() || undefined,
        zone: zone || undefined,
        pbg: pbg.toUpperCase() || undefined,
        allegiance: allegiance.trim() || undefined,
        stars: stars.trim() || undefined,
        remarks: remarks.trim() || undefined,
      };
      if (system) {
        const ops = Object.entries(fields).map(([key, value]) => (value === undefined ? { op: 'del', path: [key] } : { op: 'set', path: [key], value }));
        await act('entity.patch', { id: system.id, ops });
        if (sectorId !== system.sectorId || hexText !== system.hex) await act('system.move', { id: system.id, sectorId, hex: hexText });
        // The bodies listed for a system follow its stars and PBG.
        if ((fields.pbg ?? '') !== (system.pbg ?? '') || (fields.stars ?? '') !== (system.stars ?? '') || (fields.name ?? '') !== (system.name ?? '')) {
          await act('system.rebuildBodies', { id: system.id });
        }
      } else {
        const res = await act<{ id: string }>('system.create', { sectorId, hex: hexText, name: fields.name, uwp: fields.uwp, bases: fields.bases, pbg: fields.pbg, stars: fields.stars });
        const rest = { zone: fields.zone, allegiance: fields.allegiance, remarks: fields.remarks };
        const ops = Object.entries(rest)
          .filter(([, v]) => v !== undefined)
          .map(([key, value]) => ({ op: 'set', path: [key], value }));
        if (ops.length) await act('entity.patch', { id: res.id, ops });
        selectSystem(res.id);
      }
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  };

  return (
    <Modal
      title={system ? `Edit ${system.name ?? 'system'}` : `New system in ${hex}`}
      icon="globe"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !uwpOk || !hexOk || !pbgOk} onClick={() => void save()}>
            {system ? 'Save changes' : 'Create system'}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="col gap-12">
          <Field label="Name">
            <div className="row">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Unnamed" autoFocus />
              <button className="btn icon" title="Suggest a name" onClick={() => setName(generateName(Math.random))}>
                <Icon name="sparkles" size={14} />
              </button>
            </div>
          </Field>
          <Field label="World profile (UWP)" error={!uwpOk ? 'Use the form CA6A643-9: starport letter, six digits, a dash, tech level.' : undefined} hint="Starport, size, atmosphere, hydrographics, population, government, law – tech level.">
            <div className="row">
              <input className={`input mono ${uwpOk ? '' : 'invalid'}`} value={uwp} onChange={(e) => setUwp(e.target.value.toUpperCase().trim())} placeholder="CA6A643-9" maxLength={9} spellCheck={false} />
              <button className="btn" onClick={roll} title="Roll a random world using the rulebook's creation sequence">
                <Icon name="dice" size={13} /> Roll
              </button>
            </div>
          </Field>
          <div className="grid-2">
            <Field label="Bases" hint="e.g. NS">
              <input className="input mono" value={bases} onChange={(e) => setBases(e.target.value.toUpperCase())} maxLength={6} />
            </Field>
            <Field label="PBG" hint="Pop × / belts / gas giants" error={!pbgOk ? 'Three digits, e.g. 703' : undefined}>
              <input className="input mono" value={pbg} onChange={(e) => setPbg(e.target.value.toUpperCase())} maxLength={3} placeholder="703" />
            </Field>
          </div>
          <Field label="Travel zone">
            <Segmented
              value={zone === '' ? 'G' : zone}
              onChange={(z) => setZone(z === 'G' ? '' : (z as TravelZone))}
              options={[
                { id: 'G', label: 'Green' },
                { id: 'A', label: 'Amber' },
                { id: 'R', label: 'Red' },
              ]}
            />
          </Field>
          <div className="grid-2">
            <Field label="Stars" hint="e.g. G2 V M5 V">
              <input className="input mono" value={stars} onChange={(e) => setStars(e.target.value)} />
            </Field>
            <Field label="Allegiance">
              <input className="input" value={allegiance} onChange={(e) => setAllegiance(e.target.value)} maxLength={8} />
            </Field>
          </div>
          <Field label="Remarks" hint="Extra codes or comments from the source data.">
            <input className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
          <div className="grid-2">
            <Field label="Sector">
              <select className="select" value={sectorId} onChange={(e) => setSectorId(e.target.value)}>
                {sectors.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Hex" error={!hexOk ? '0101 to 3240' : undefined}>
              <input className={`input mono ${hexOk ? '' : 'invalid'}`} value={hexText} onChange={(e) => setHexText(e.target.value.trim())} maxLength={4} />
            </Field>
          </div>
        </div>
        <div className="col">
          <h3>What this profile means</h3>
          {decoded.length === 0 ? (
            <div className="faint small">Enter a world profile, or roll one, to see it decoded.</div>
          ) : (
            <dl className="kv">
              {decoded.map((row) => (
                <div key={row.key} style={{ display: 'contents' }}>
                  <dt>
                    {row.label} <span className="mono">{row.code}</span>
                  </dt>
                  <dd>
                    {row.value}
                    {row.detail && <div className="tiny faint">{row.detail}</div>}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {codes.length > 0 && (
            <div className="row wrap" style={{ marginTop: 8 }}>
              {codes.map((c) => (
                <span key={c} className="chip mono">
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
