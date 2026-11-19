import type { ReactNode } from "react";
import { ago } from "../lib/format";
import { Link } from "../lib/router";
import { Nil, Table, Td, Th } from "../ui/table";
import { useAdmin } from "./api";
import { Avatar, percent } from "./kit";
import { AdminHeader, Failed, Loading, Section, n, stamp } from "./ui";

interface Rate { n: number; of: number }
interface Cohort { start: number; size: number; d1: Rate | null; d7: Rate | null; d30: Rate | null; weekly: Array<number | null> }
interface PowerUser {
  id: string; email: string; name: string | null; avatarUrl?: string; avatar?: string; activeDays: number; opens: number;
  sent: number; replies: number; features: number; lastAt: number; customer: boolean;
}
interface RetentionAnswer { now: number; cohorts: Cohort[]; power: PowerUser[] }

const WEEKS = Array.from({ length: 8 }, (_, i) => i);
const weekOf = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
const rateText = (rate: Rate | null) => rate ? `${percent(rate.n / rate.of)} (${n(rate.n)} of ${n(rate.of)})` : "-";
const heat = (value: number | null) => value === null ? "transparent" : value === 0 ? "var(--cell)" : `var(--heat-${value <= 0.25 ? 1 : value <= 0.5 ? 2 : value <= 0.75 ? 3 : 4})`;

export function RetentionPage({ tabs }: { tabs?: ReactNode }) {
  const { data, error, loading, reload } = useAdmin<RetentionAnswer>("/retention");
  return (
    <>
      <AdminHeader title="retention" sub="who comes back after signing up, and who uses Metal most" tabs={tabs} />
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <Table label="signup cohorts">
            <thead><tr><Th>week of</Th><Th className="!text-end">people</Th><Th>d1</Th><Th>d7</Th><Th>d30</Th>{WEEKS.map((week) => <Th key={week} className="!px-2 !text-center">week {week}</Th>)}</tr></thead>
            <tbody>
              {data.cohorts.map((cohort) => (
                <tr key={cohort.start} className="hover-row">
                  <Td className="whitespace-nowrap text-ink-2">{weekOf(cohort.start)}</Td>
                  <Td className="text-end font-mono num">{n(cohort.size)}</Td>
                  <Td className="whitespace-nowrap font-mono text-13 num">{rateText(cohort.d1)}</Td>
                  <Td className="whitespace-nowrap font-mono text-13 num">{rateText(cohort.d7)}</Td>
                  <Td className="whitespace-nowrap font-mono text-13 num">{rateText(cohort.d30)}</Td>
                  {WEEKS.map((week) => {
                    const value = cohort.weekly[week] ?? null;
                    const label = value === null ? "not yet" : percent(value);
                    return (
                      <Td key={week} className="!px-2">
                        <span role="img" aria-label={label} className="mx-auto grid size-7 place-items-center rounded-[6px] text-12 text-ink-4" style={{ backgroundColor: heat(value) }} title={`${weekOf(cohort.start)}, week ${week}: ${label}`}>
                          {value === null && <span aria-hidden>-</span>}
                        </span>
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-3 text-12 text-ink-4">d1 is the day after signing up, d7 days 7 to 13, d30 days 30 to 59. empty cells have not happened yet.</p>
          <Section title="power users, last 30 days">
            {data.power.length ? (
              <Table label="power users, last 30 days">
                <thead><tr><Th>person</Th><Th className="!text-end">active days</Th><Th className="!text-end">app opens</Th><Th className="!text-end">messages sent</Th><Th className="!text-end">replies</Th><Th className="!text-end">features used</Th><Th>last seen</Th></tr></thead>
                <tbody>
                  {data.power.map((user) => (
                    <tr key={user.id} className="hover-row">
                      <Td>
                        <div className="flex items-center gap-3">
                          <Avatar seed={user.id} size={24} customer={user.customer} account={user} />
                          <div className="min-w-0 max-w-[280px]">
                            <Link to={`/admin/users/${encodeURIComponent(user.id)}`} className="text-link block truncate rounded-[6px] text-14">{user.email}</Link>
                            <span className="block truncate text-12 text-ink-3">{user.name ?? <Nil />}</span>
                          </div>
                        </div>
                      </Td>
                      <Td className="text-end font-mono num">{n(user.activeDays)}</Td>
                      <Td className="text-end font-mono num">{n(user.opens)}</Td>
                      <Td className="text-end font-mono num">{n(user.sent)}</Td>
                      <Td className="text-end font-mono num">{n(user.replies)}</Td>
                      <Td className="text-end font-mono num">{n(user.features)}</Td>
                      <Td className="whitespace-nowrap text-13 text-ink-3" title={stamp(user.lastAt)}>{ago(user.lastAt, data.now).toLowerCase()}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : <p className="text-14 text-ink-3">nobody yet.</p>}
          </Section>
        </>
      )}
    </>
  );
}
