import { useEffect, useState, type ReactNode } from 'react';
import { ArrowClockwiseIcon, ArrowSquareOutIcon, SignInIcon, DotsThreeIcon, PlusIcon, BookOpenTextIcon, BrainIcon, LifebuoyIcon, PaperPlaneTiltIcon, CaretUpDownIcon, CheckIcon, GitPullRequestIcon, ListChecksIcon, ScalesIcon, SignOutIcon } from '@phosphor-icons/react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { ADD_REPOS_URL, signInUrl, type Org, type Session } from './api';
import { ago } from './format';
import { EMAIL, GITHUB } from '../links';

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

/** The person who is signed in. Their picture comes from GitHub, by their GitHub user id. */
function Who({ user }: { user: Session['user'] }) {
  return (
    <>
      <Avatar className="size-8 rounded-xl after:rounded-xl">
        <AvatarImage src={`https://avatars.githubusercontent.com/u/${user.id}?s=80`} alt="" className="rounded-xl" />
        <AvatarFallback className="rounded-xl uppercase">{user.login.slice(0, 1)}</AvatarFallback>
      </Avatar>
      <span className="grid flex-1 text-left leading-tight">
        <span className="truncate font-medium">{user.login}</span>
        <span className="truncate text-xs text-muted-foreground">Signed in with GitHub</span>
      </span>
    </>
  );
}

function NavUser({ user, onSignOut }: { user: Session['user']; onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton size="lg" aria-label="Your account" />}>
        <Who user={user} />
        <CaretUpDownIcon className="ml-auto size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2 py-1.5 font-normal text-foreground">
            <Who user={user} />
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut}>
          <SignOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Updated 2 minutes ago". It counts on by itself, so an old page says it is old. */
function Updated({ at }: { at: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="hidden text-sm text-muted-foreground sm:inline">Updated {ago(new Date(at).toISOString())}</span>;
}

/** The page's own actions, out of the way until someone needs them. */
function PageMenu({ orgLogin, onRefresh }: { orgLogin: string; onRefresh: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
        <DotsThreeIcon weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuItem onClick={onRefresh}>
          <ArrowClockwiseIcon />
          Refresh {orgLogin}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Don't see an org or a repository?</DropdownMenuLabel>
          <DropdownMenuItem render={<a href={ADD_REPOS_URL} target="_blank" rel="noreferrer" />}>
            <PlusIcon />
            Add it on GitHub
            <ArrowSquareOutIcon className="ml-auto text-muted-foreground" />
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={signInUrl()} />}>
            <SignInIcon />
            Then sign in again
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ user, orgs, org, onPickOrg, view, onView, onSignOut, loadedAt, onRefresh, children }: { user: Session['user']; orgs: Org[]; org: Org; onPickOrg: (id: number) => void; view: ViewId; onView: (v: ViewId) => void; onSignOut: () => void; loadedAt: number | null; onRefresh: () => void; children: ReactNode }) {
  const group = VIEWS.find((g) => g.items.some((i) => i.id === view)) ?? VIEWS[0];
  const here = { label: group.items.find((i) => i.id === view)?.label ?? '' };
  return (
    <SidebarProvider>
      <Sidebar variant="floating">
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
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" render={<a href={`mailto:${EMAIL}?subject=Mergelight%20support`} />}>
                <LifebuoyIcon />
                <span>Support</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" render={<a href={`${GITHUB}/issues/new`} target="_blank" rel="noreferrer" />}>
                <PaperPlaneTiltIcon />
                <span>Feedback</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarMenu className="mt-2">
            <SidebarMenuItem>
              <NavUser user={user} onSignOut={onSignOut} />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-center" />
          <h1 className="truncate text-sm font-medium">{here.label}</h1>
          <div className="ml-auto flex items-center gap-2">
            {loadedAt && <Updated at={loadedAt} />}
            <PageMenu orgLogin={org.login} onRefresh={onRefresh} />
          </div>
        </header>
        <div className="w-full px-4 pb-16 pt-2">{children}</div>
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
