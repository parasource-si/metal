import type { ReactNode } from "react";
import type { ComputerReport, WorkspaceDetail } from "../../../../shared/dashboard-protocol";
import { ago, bytes, duration, percent, rate } from "../lib/format";
import { Badge, Bar, Button, Card, cx, KV, SectionTitle } from "../ui/kit";
import { BotMascot, Mascot } from "../ui/Mascot";
import { PixelIcon, type PixelIconName } from "@/components/ui/PixelIcon";
import { appLink, openApp } from "../lib/app-link";
import { pastelIndex } from "../ui/Avatar";
import { Spark } from "../ui/Spark";
import { ComputerActions, StatePill } from "./Bots";

export function Metric({ label, value, sub, children }: { label: string; value: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col !p-5">
      <div className="text-13 text-ink-3">{label}</div>
      <div className="num swap mt-1.5 truncate text-20 font-medium tracking-[-0.01em] text-ink">{value}</div>
      <div className="mt-0.5 h-4 truncate text-12 text-ink-4">{sub}</div>
      <div className="mt-auto pt-4">{children}</div>
    </Card>
  );
}

const COMPUTER_KIND: Record<ComputerReport["kind"], string> = { vps: "cloud computer", "local-vm": "mac vm", team: "bot computer" };
const COMPUTER_COLOURS = ["blue", "purple", "pink", "yellow", "green"] as const;

/** never the reporter's own words for it ("Shared computer"): the bot's name, or what kind of computer it is */
export function computerName(c: ComputerReport): string {
  return c.botName ?? COMPUTER_KIND[c.kind];
}

function computerLine(c: ComputerReport, now: number): string {
  if (c.state === "missing") return "not set up yet";
  if (c.state === "running") return c.lastUsedAt ? `up · last used ${ago(c.lastUsedAt, now)}` : "up";
  if (c.lastUsedAt) return `last used ${ago(c.lastUsedAt, now)}`;
  return c.state === "asleep" ? "asleep" : c.state === "starting" ? "waking" : COMPUTER_KIND[c.kind];
}

export function ComputerRow({ c, detail, now }: { c: ComputerReport; detail: WorkspaceDetail; now: number }) {
  const bot = detail.report?.bots?.find((b) => b.id === c.botId) ?? null;
  const name = computerName(c);
  const sleepy = c.state !== "running" && c.state !== "starting";
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_110px_auto] items-center gap-4 py-3 max-md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 items-center gap-3">
        {bot ? <BotMascot bot={bot} size={30} mood={sleepy ? "sleeping" : undefined} /> : <Mascot color={COMPUTER_COLOURS[pastelIndex(c.id)]} size={30} state={sleepy ? "sleeping" : "idle"} />}
        <div className="min-w-0">
          <div className="truncate text-14 text-ink">{name}</div>
          <div className="truncate text-13 text-ink-3">{computerLine(c, now)}</div>
        </div>
      </div>
      <div className="max-md:hidden"><StatePill state={c.state} /></div>
      <div className="flex justify-end">
        {c.state === "missing"
          ? <Button size="sm" onClick={() => openApp(c.botId ? appLink.bot(c.botId) : appLink.app)} aria-label={`set up ${name} in the app`}>set up</Button>
          : c.botId ? <ComputerActions bot={{ id: c.botId, name: c.botName ?? name }} computer={c} /> : null}
      </div>
    </li>
  );
}

const SERVICE_ICON: Record<string, PixelIconName> = { server: "server", docker: "parcel", link: "globe", phone: "bolt" };

function ServiceRow({ id, name, tone, state }: { id: string; name: string; tone: string; state: string }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <PixelIcon name={SERVICE_ICON[id] ?? "gauge"} size={22} />
      <span className="min-w-0 flex-1 truncate text-14 text-ink">{name.toLowerCase()}</span>
      <span className="inline-flex min-w-0 items-center gap-2 truncate text-13 text-ink-3"><span className={cx("live-dot !size-1.5 shrink-0", tone)} aria-hidden />{state}</span>
    </li>
  );
}

/** one workspace's machine: live meters, the server, its services and its bot computers */
const STALE_MS = 15 * 60_000;
const LINK = { direct: "direct", relay: "through the relay", off: "off" } as const;

export function MachineView({ detail, now, region }: { detail: WorkspaceDetail; now: number; region?: string }) {
  const m = detail.report?.machine;
  const h = detail.history;
  const computers = detail.report?.computers;
  if (!m) return <Card><p className="text-14 text-ink-3">this workspace has not sent machine stats yet.</p></Card>;
  const memPct = (m.memory.usedBytes / Math.max(1, m.memory.totalBytes)) * 100;
  const diskPct = m.disk ? (m.disk.usedBytes / Math.max(1, m.disk.totalBytes)) * 100 : 0;
  const running = computers?.computers.filter((c) => c.state === "running").length ?? 0;
  const link = detail.report?.devices?.link ?? null;
  const at = detail.report?.at ?? null;
  const stale = !!at && now - at > STALE_MS;
  return (
    <div className="flex flex-col gap-4">
      {stale && <Card className="!py-4"><p className="text-14 text-ink">not heard from in {ago(at, now).replace(/ ago$/, "")}</p><p className="mt-1 text-13 text-ink-3">these numbers are from its last report. it may be off or offline.</p></Card>}
      <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-2">
        <Metric label="cpu" value={percent(m.cpu.percent)} sub={`load ${m.cpu.load.map((l) => l.toFixed(2)).join(" ")}`}><Spark values={h.map((s) => s.cpu)} max={100} /></Metric>
        <Metric label="memory" value={percent(memPct)} sub={`${bytes(m.memory.usedBytes)} of ${bytes(m.memory.totalBytes)}`}><Spark values={h.map((s) => s.mem)} max={100} /></Metric>
        <Metric label="disk" value={m.disk ? percent(diskPct) : "n/a"} sub={m.disk ? `${bytes(m.disk.usedBytes)} of ${bytes(m.disk.totalBytes)}` : undefined}>
          <div className="flex h-10 items-end"><Bar value={diskPct} className="w-full" tone={diskPct > 90 ? "warn" : "ink"} label="disk used" /></div>
        </Metric>
        <Metric label="network" value={m.network ? rate(m.network.rxBytesPerSec) : "n/a"} sub={m.network ? `${rate(m.network.txBytesPerSec)} out` : undefined}><Spark values={h.map((s) => s.rx)} /></Metric>
      </div>
      <Card aria-labelledby="computers-title">
        <SectionTitle id="computers-title" action={<span className="num text-13 text-ink-3">{running} running</span>}>bot computers</SectionTitle>
        {computers?.computers.length ? (
          <>
            <ul className="">{computers.computers.map((c) => <ComputerRow key={c.id} c={c} detail={detail} now={now} />)}</ul>
            <p className="num mt-2 text-13 text-ink-3">they all share this machine: {percent(m.cpu.percent)} cpu, {bytes(m.memory.usedBytes)} of {bytes(m.memory.totalBytes)} memory in use.</p>
          </>
        ) : (
          <div className="flex items-center gap-4 py-2">
            <Mascot color="silver" size={36} state="sleeping" />
            <div className="min-w-0 flex-1">
              <p className="text-14 text-ink">no bot computers yet</p>
              <p className="mt-0.5 text-13 text-ink-3">{computers?.provider === "none" ? "give a bot a computer in the app's bot settings." : "they show up once a bot uses its computer."}</p>
            </div>
            {computers?.provider === "none" && <Button size="sm" onClick={() => openApp(appLink.app)}>open the app</Button>}
          </div>
        )}
      </Card>
      <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <SectionTitle action={m.update?.available ? <Badge tone="accent">update {m.update.latest} ready</Badge> : <Badge>up to date</Badge>}>server</SectionTitle>
          <dl className="">
            <KV k="Metal running for" v={duration(m.processUptimeSec)} />
            {region && <KV k="region" v={region} />}
            <KV k="processor" v={`${m.host.cpus} ${m.host.cpus === 1 ? "core" : "cores"}${m.host.cpuModel ? ` · ${m.host.cpuModel}` : ""}`} />
            <KV k="version" v={`${m.app.version} · node ${m.app.node}`} />
            <KV k="last report" v={ago(detail.report?.at ?? null, now)} />
          </dl>
          {m.update?.available && m.update.how && <p className="mt-4 text-13 leading-[1.5] text-ink-3">{m.update.how}</p>}
        </Card>
        <Card>
          <SectionTitle>services</SectionTitle>
          <ul className="">
            {m.services.map((s) => <ServiceRow key={s.id} id={s.id} name={s.name} tone={s.state === "running" ? "text-good" : s.state === "stopped" ? "text-bad" : "text-ink-4"} state={s.state === "running" ? "running" : s.state === "stopped" ? "stopped" : "unknown"} />)}
            {link && <ServiceRow id="phone" name="phone link" tone={link.mode === "off" ? "text-ink-4" : link.connected ? "text-good" : "text-warn"} state={link.mode === "off" ? "off" : link.connected ? LINK[link.mode] : "reconnecting"} />}
          </ul>
        </Card>
      </div>
    </div>
  );
}
