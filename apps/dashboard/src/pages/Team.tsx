import { useCallback, useEffect, useState } from "react";
import type { TeamView } from "../../../../shared/billing-api";
import type { ChangeOffer } from "../data/contracts";
import { Minus, Plus } from "@/icons";
import { useCloud } from "../data/cloud";
import { useSession } from "../data/session";
import { dropTeamInvite, teamApi, teamInvite } from "../data/team";
import { ApiError } from "../lib/api";
import { longDate, plural, usd } from "../lib/format";
import { navigate } from "../lib/router";
import { Field, Modal } from "../ui/controls";
import { Bar, Badge, Button, ButtonLink, PageHeader, SectionTitle, Skeleton } from "../ui/kit";
import { SkyEmpty } from "../ui/Sky";

const DAY = 86_400_000;

function useTeam() {
  const [team, setTeam] = useState<TeamView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { setError(null); teamApi.get().then(setTeam, (e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  return { team, setTeam, error, load };
}

export function TeamPage() {
  const { team, setTeam, error, load } = useTeam();
  const { toast } = useSession();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamView["members"][number] | null>(null);
  const [adding, setAdding] = useState(false);
  if (team === undefined) return <div className="mx-auto max-w-[720px]"><PageHeader title="team" />{error ? <section><p role="alert" className="text-13 text-bad">could not load your team. {error}</p><Button className="mt-4" size="sm" onClick={load}>retry</Button></section> : <div className="flex flex-col gap-4" aria-busy="true" aria-label="loading team"><Skeleton className="h-28 !rounded-card" /><Skeleton className="h-56 !rounded-card" /></div>}</div>;
  if (team === null) return <SkyEmpty art="cat" title="you're not in a team." action={<ButtonLink to="/billing" variant="primary">see the team plan</ButtonLink>}>the team plan gives a few people one dusk cloud and the bots on it. someone on it can invite you, or you can start one.</SkyEmpty>;
  const owner = team.role === "owner", seats = team.seats;
  const held = seats.used + seats.pending, free = Math.max(0, seats.paid - held);
  const act = async (key: string, run: () => Promise<TeamView>, done: string) => {
    setBusy(key);
    try { setTeam(await run()); toast(done); return true; }
    catch (e) { toast((e as Error).message, "bad"); return false; }
    finally { setBusy(null); }
  };
  const invite = async () => {
    const address = email.trim();
    if (!address) { setInviteError("enter their email."); return; }
    setBusy("invite"); setInviteError(null);
    try { setTeam(await teamApi.invite(address)); setEmail(""); toast(`invite sent to ${address.toLowerCase()}`); }
    catch (e) { setInviteError((e as Error).message); }
    finally { setBusy(null); }
  };
  return <div className="mx-auto min-w-0 max-w-[720px]">
    <PageHeader title="team" sub={owner ? team.name : `you're in ${team.name}, run by ${team.owner.name ?? team.owner.email}.`} />
    <section aria-labelledby="seats-title">
      <SectionTitle id="seats-title" action={owner && seats.paid < seats.max ? <Button size="sm" variant="outline" disabled={busy !== null || seats.changing !== null} onClick={() => setAdding(true)}><Plus size={14} strokeWidth={1.75} aria-hidden /> add seats</Button> : undefined}>seats</SectionTitle>
      <div className="rounded-card bg-card-2 px-5 py-4">
        <p className="num text-20 font-medium text-ink">{seats.used} of {seats.paid} seats used</p>
        <Bar className="mt-3" value={seats.paid ? Math.min(100, (seats.used / seats.paid) * 100) : 0} tone={held >= seats.paid ? "warn" : "accent"} label={`${seats.used} of ${seats.paid} seats used`} />
        <p className="mt-3 text-13 text-ink-3">{[`${seats.included} included`, seats.paid > seats.included ? `${plural(seats.paid - seats.included, "extra seat")} at ${usd(seats.extraSeatCents / 100)} a month each` : null,
          seats.pending ? `${plural(seats.pending, "invite")} waiting, holding ${seats.pending === 1 ? "a seat" : "seats"}` : null, owner ? `${free} free` : null].filter(Boolean).join(" · ")}</p>
        {seats.changing !== null && <p className="mt-2 text-13 text-ink-2">changing to {seats.changing} seats. it shows here once the payment goes through.</p>}
      </div>
    </section>
    <section className="mt-10" aria-labelledby="people-title">
      <SectionTitle id="people-title">people</SectionTitle>
      <ul>{team.members.map((member, index) => <li key={member.email} className="flex flex-wrap items-center gap-3 py-3">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-card-2 text-13 font-medium text-ink-2">{(member.name ?? member.email).charAt(0).toLowerCase()}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-14 text-ink">{member.name ?? member.email.split("@")[0]}{member.you && <span className="text-ink-3"> (you)</span>}</p>
          <p className="truncate text-13 text-ink-3">{[member.email, `joined ${longDate(member.joinedAt).toLowerCase()}`, `seat ${index + 1}`].join(" · ")}</p>
        </div>
        <Badge tone={member.role === "owner" ? "accent" : "plain"}>{member.role}</Badge>
        {owner && member.role !== "owner" && <Button size="sm" variant="ghost" className="-me-3.5" disabled={busy !== null} onClick={() => setRemoving(member)}>remove</Button>}
      </li>)}</ul>
      {owner && team.invites.length > 0 && <>
        <h3 className="t-meta mt-6 pb-1.5">invites waiting</h3>
        <ul>{team.invites.map((row) => <li key={row.id} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-14 text-ink">{row.email}</p>
            <p className="text-13 text-ink-3">sent {longDate(row.createdAt).toLowerCase()} · works {Math.max(1, Math.ceil((row.expiresAt - Date.now()) / DAY))} more {Math.ceil((row.expiresAt - Date.now()) / DAY) > 1 ? "days" : "day"}</p>
            {row.refusedAt !== null && <p className="mt-1 text-13 text-warn">they tried to join, but every seat was taken. add a seat and the same link works.</p>}
          </div>
          <Button size="sm" variant="ghost" className="-me-3.5" disabled={busy !== null} onClick={() => void act(`cancel-${row.id}`, () => teamApi.cancel(row.id), "invite cancelled")}>{busy === `cancel-${row.id}` ? "cancelling" : "cancel"}</Button>
        </li>)}</ul>
      </>}
    </section>
    {owner && <section className="mt-10" aria-labelledby="invite-title">
      <SectionTitle id="invite-title">invite someone</SectionTitle>
      {free > 0 ? <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void invite(); }}>
        <div className="min-w-[240px] flex-1"><Field label="their email" htmlFor="invite-email" error={inviteError}><input id="invite-email" type="email" className="field" autoComplete="off" maxLength={254} value={email} disabled={busy !== null} aria-invalid={Boolean(inviteError)} onChange={(e) => setEmail(e.target.value)} /></Field></div>
        <Button type="submit" variant="primary" disabled={busy !== null}>{busy === "invite" ? "sending" : "send invite"}</Button>
      </form> : <div className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-card-2 px-5 py-4">
        <p className="min-w-0 flex-1 text-14 text-ink-2">every seat is {seats.pending ? "used or held by an invite" : "used"}. add a seat to invite someone else.</p>
        {seats.paid < seats.max && <Button size="sm" variant="primary" disabled={busy !== null || seats.changing !== null} onClick={() => setAdding(true)}>add seats</Button>}
      </div>}
      <p className="mt-3 text-13 text-ink-3">they get an email with a link. it works once, for 7 days, and only for the address you invite.</p>
    </section>}
    {team.cloud && <section className="mt-10" aria-labelledby="team-cloud-title">
      <SectionTitle id="team-cloud-title">the team's cloud</SectionTitle>
      <p className="text-14 text-ink-3">{team.cloud.joinable
        ? `everyone in ${team.name} opens it from the Metal app, signed in with the email they joined with. removing someone signs them out of it at once.`
        : "it was made before it became a team cloud, so members can't open it yet. your own access, its size and your seats are all set."}</p>
    </section>}
    <Modal open={removing !== null} onClose={() => busy === null && setRemoving(null)} title={`remove ${removing?.email ?? ""}?`} footer={<><Button disabled={busy !== null} onClick={() => setRemoving(null)}>cancel</Button><Button variant="danger" disabled={busy !== null} onClick={() => removing && void act("remove", () => teamApi.remove(removing.email), `${removing.email} removed`).then(() => setRemoving(null))}>{busy === "remove" ? "removing" : "remove"}</Button></>}>
      <p>they're signed out of the team's cloud at once, and their private chats there are deleted. their seat frees up; your plan doesn't change.</p>
    </Modal>
    {adding && <AddSeats team={team} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
  </div>;
}

function AddSeats({ team, onClose, onDone }: { team: TeamView; onClose(): void; onDone(): void }) {
  const cloud = useCloud();
  const { toast } = useSession();
  const [count, setCount] = useState(1);
  const [offer, setOffer] = useState<ChangeOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selection = cloud.billing?.subscription?.selection ?? null;
  const target = team.seats.paid + count, room = team.seats.max - team.seats.paid;
  useEffect(() => {
    if (!selection) return;
    let live = true;
    setOffer(null); setError(null);
    cloud.changeCharge({ ...selection, members: target }).then((next) => live && setOffer(next), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [target, selection?.license]);
  const confirm = async () => {
    if (!selection || offer === null) return;
    setBusy(true); setError(null);
    try { await cloud.changePlan({ ...selection, members: target }, offer.todayUsd); toast(`${plural(count, "seat")} added`); onDone(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const each = team.seats.extraSeatCents / 100;
  return <Modal open onClose={() => !busy && onClose()} title="add seats" footer={<><Button disabled={busy} onClick={onClose}>cancel</Button><Button variant="primary" disabled={busy || offer === null || !selection} onClick={() => void confirm()}>{busy ? "adding" : `add ${plural(count, "seat")}`}</Button></>}>
    <div className="flex items-center justify-between gap-4">
      <p className="text-14 text-ink">extra seats</p>
      <div className="flex items-center gap-1" role="group" aria-label="seats to add">
        <Button size="sm" variant="ghost" aria-label="one fewer" disabled={busy || count <= 1} onClick={() => setCount((n) => n - 1)}><Minus size={14} aria-hidden /></Button>
        <span className="num w-8 text-center text-16 text-ink" aria-live="polite">{count}</span>
        <Button size="sm" variant="ghost" aria-label="one more" disabled={busy || count >= room} onClick={() => setCount((n) => n + 1)}><Plus size={14} aria-hidden /></Button>
      </div>
    </div>
    <p className="mt-3 text-13 text-ink-3">{team.seats.paid} seats now, {target} after. each extra seat is {usd(each)} a month{team.seats.interval === "year" ? ", billed yearly" : ""}.</p>
    <p className="mt-2 text-14 text-ink">{error ? "" : offer === null ? "working out the price…" : offer.todayUsd > 0 ? `${usd(offer.todayUsd)}${offer.taxUsd > 0 ? ", tax included," : ""} is charged now for the rest of this period.` : "nothing is charged now. it's on your next bill."}</p>
    {!selection && <p className="mt-2 text-13 text-bad">your plan isn't loaded yet. close this and try again.</p>}
    {error && <p role="alert" className="mt-2 text-13 text-bad">{error}</p>}
  </Modal>;
}

/** where an emailed invite lands once its person is signed in */
export function TeamJoinPage() {
  const { refresh } = useCloud();
  const { account, toast } = useSession();
  const [token] = useState(teamInvite);
  const [state, setState] = useState<{ kind: "joining" } | { kind: "failed"; message: string; code: string | null }>({ kind: "joining" });
  const join = useCallback(async () => {
    if (!token) return;
    setState({ kind: "joining" });
    try {
      const team = await teamApi.join(token);
      dropTeamInvite(); refresh(); toast(`you're in ${team.name}`);
      navigate("/team", { replace: true });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null;
      if (code === "invite_invalid") dropTeamInvite();
      setState({ kind: "failed", message: (e as Error).message, code });
    }
  }, [token]);
  useEffect(() => { void join(); }, [join]);
  if (!token) return <SkyEmpty art="cat" title="this invite link is incomplete." action={<ButtonLink to="/" variant="primary">go home</ButtonLink>}>open the link from your invite email again, the whole thing.</SkyEmpty>;
  if (state.kind === "joining") return <div className="mx-auto max-w-[520px] py-16 text-center text-14 text-ink-3" aria-busy="true">joining the team…</div>;
  const full = state.code === "seats_full";
  return <SkyEmpty art="cat" title={full ? "no free seat yet." : state.code === "invite_other_email" ? "this invite is for another email." : "couldn't join the team."}
    action={full ? <Button variant="primary" onClick={() => void join()}>try again</Button> : <ButtonLink to="/" variant="primary">go home</ButtonLink>}>
    {full ? "every seat on this team is taken right now. we told the owner. once they add a seat, open this page again or press try again."
      : state.code === "invite_other_email" ? `you're signed in as ${account?.email ?? "someone else"}. sign in with the address the invite went to, then open the link again.`
      : state.message}
  </SkyEmpty>;
}
