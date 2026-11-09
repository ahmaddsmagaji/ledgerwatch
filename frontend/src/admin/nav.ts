export interface NavItem {
  path: string
  label: string
  step: number
  blurb: string
}

export const NAV: NavItem[] = [
  { path: '/admin', label: 'Dashboard', step: 2, blurb: 'Platform KPIs, MRR chart, recent organizations and system health.' },
  { path: '/admin/organizations', label: 'Organizations', step: 3, blurb: 'Search, filter and manage customer organizations.' },
  { path: '/admin/users', label: 'Users & Roles', step: 4, blurb: 'Users, roles and the permission matrix.' },
  { path: '/admin/workspaces', label: 'Workspaces', step: 5, blurb: 'Workspaces, members and data sources.' },
  { path: '/admin/billing', label: 'Subscriptions & Billing', step: 6, blurb: 'Plans, invoices and plan-change history.' },
  { path: '/admin/runs', label: 'Reconciliation Runs', step: 7, blurb: 'Platform-wide reconciliation runs.' },
  { path: '/admin/exceptions', label: 'Exceptions', step: 8, blurb: 'Exceptions that need investigation, across organizations.' },
  { path: '/admin/audit', label: 'Audit Log', step: 9, blurb: 'Every administrative action, in one place.' },
  { path: '/admin/flags', label: 'Feature Flags', step: 10, blurb: 'Feature toggles and their descriptions.' },
  { path: '/admin/support', label: 'Support Tickets', step: 11, blurb: 'Customer tickets, replies and status.' },
  { path: '/admin/settings', label: 'Settings', step: 12, blurb: 'Platform name, currency, maintenance mode and announcements.' },
]
