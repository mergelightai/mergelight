import type { ReactNode } from 'react';
import { BookOpenTextIcon, BrainIcon, CaretUpDownIcon, CheckIcon, GitPullRequestIcon, ListChecksIcon, ScalesIcon, SignOutIcon } from '@phosphor-icons/react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import type { Org } from './api';

export type ViewId = 'reviews' | 'rules' | 'skills' | 'checks' | 'decisions';

/** The views, in the order of the menu. New views (the team view, settings) go into these groups later. */
export const VIEWS: { group: string; items: { id: ViewId; label: string; icon: typeof GitPullRequestIcon }[] }[] = [
  { group: 'Overview', items: [{ id: 'reviews', label: 'Reviews', icon: GitPullRequestIcon }] },
  {
    group: 'What the reviewer knows',
    items: [
      { id: 'rules', label: 'Rules', icon: ScalesIcon },
      { id: 'skills', label: 'Skills', icon: BookOpenTextIcon },
      { id: 'checks', label: 'Checks', icon: ListChecksIcon },
      { id: 'decisions', label: 'Decisions', icon: BrainIcon },
    ],
  },
];

function OrgPicker({ orgs, org, onPick }: { orgs: Org[]; org: Org; onPick: (id: number) => void }) {
  const badge = (o: Org) => (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-sm font-semibold uppercase text-primary">{o.login.slice(0, 1)}</span>
  );
  if (orgs.length < 2) {
    return (
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        {badge(org)}
        <span className="truncate font-heading text-sm font-medium">{org.login}</span>
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton size="lg" aria-label="Switch org" />}>
        {badge(org)}
        <span className="grid flex-1 text-left leading-tight">
          <span className="truncate font-heading text-sm font-medium">{org.login}</span>
          <span className="truncate text-xs text-muted-foreground">{orgs.length} orgs</span>
        </span>
        <CaretUpDownIcon className="ml-auto size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Orgs</DropdownMenuLabel>
          {orgs.map((o) => (
            <DropdownMenuItem key={o.id} onClick={() => onPick(o.id)}>
              {badge(o)}
              <span className="flex-1 truncate">{o.login}</span>
              {o.id === org.id && <CheckIcon className="size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ login, orgs, org, onPickOrg, view, onView, onSignOut, children }: { login: string; orgs: Org[]; org: Org; onPickOrg: (id: number) => void; view: ViewId; onView: (v: ViewId) => void; onSignOut: () => void; children: ReactNode }) {
  return (
    <SidebarProvider>
      <Sidebar variant="inset">
        <SidebarHeader>
          <a href="/" className="flex items-center gap-2 px-2 pb-2 pt-1 font-heading text-[15px] font-semibold tracking-tight">
            <img src="/logo.png" alt="" className="size-6 rounded-md" /> Mergelight
          </a>
          <SidebarMenu>
            <SidebarMenuItem>
              <OrgPicker orgs={orgs} org={org} onPick={onPickOrg} />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {VIEWS.map((g) => (
            <SidebarGroup key={g.group}>
              <SidebarGroupLabel>{g.group}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {g.items.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton isActive={view === item.id} onClick={() => onView(item.id)}>
                        <item.icon weight={view === item.id ? 'fill' : 'regular'} />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-2 px-2 py-1.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase">{login.slice(0, 1)}</span>
              <span className="flex-1 truncate text-sm">{login}</span>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onSignOut}>
                <SignOutIcon />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 px-4 md:hidden">
          <SidebarTrigger />
          <span className="font-heading text-sm font-medium">{org.login}</span>
        </header>
        <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-2 md:px-8 md:pt-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function ViewHeader({ title, lead, action }: { title: string; lead?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
        {lead && <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{lead}</p>}
      </div>
      {action}
    </div>
  );
}
