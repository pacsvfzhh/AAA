import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../../src/components/admin/EmployeeManagement.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('EmployeeManagement.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    functions.set(node.name.text, node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);

function harness(t, { dispatchChanged = false, failWrite = false, failDispatch = false, failRead = false, invalidateRead = false } = {}) {
  const admin = { id: 'qa-admin', username: 'qa-root', role: 'super_admin' };
  const employee = { id: 'qa-employee', username: 'qa-worker', employee_id: 'QA-1', remarks: 'before', region_id: 'qa-region', created_by: admin.id };
  const serverEmployee = { ...employee };
  const calls = [];
  const setters = [];
  let heldRead;
  let invalidated = false;
  const pendingReads = [];
  const context = createContext({
    console: { error() {} },
    setTimeout,
    clearTimeout,
    admin,
    employeeGroupsRef: { current: [{ admin, employees: [employee] }] },
    isMountedRef: { current: true },
    loadInProgressRef: { current: false },
    pendingReloadRef: { current: false },
    pendingReloadTimerRef: { current: null },
    guardedLoadEmployeesRef: { current: null },
    realtimeChangeGenerationRef: { current: 0 },
    employeeScopeGenerationRef: { current: 0 },
    editingEmployee: { ...employee, remarks: 'after' },
    editingEmployeeInitialRef: { current: { username: employee.username, employeeId: employee.employee_id, remarks: employee.remarks, regionId: employee.region_id, dispatchGroupId: 'qa-group-1', planId: '' } },
    editingDispatchGroupId: dispatchChanged ? 'qa-group-2' : 'qa-group-1',
    currentDispatchGroup: { id: 'qa-group-1', name: 'Group 1' },
    dispatchGroups: [{ id: 'qa-group-1', group_name: 'Group 1' }, { id: 'qa-group-2', group_name: 'Group 2' }],
    dispatchGroupsLoading: false,
    dispatchGroupsError: null,
    editingAutomationPlanId: '',
    editingAutomationPlanTouched: false,
    automationAssignmentsByEmployee: new Map(),
    automationPlans: [],
    regionNameById: new Map([['qa-region', 'QA region']]),
    savingEmployeeEdit: false,
    editEmployeeError: null,
    loadError: null,
    notification: null,
    AUTO_REFRESH_INTERVAL_MS: 180000,
    AUTO_REFRESH_RETRY_MS: 5000,
    REGION_REQUIRED_MESSAGE: '請選擇所在地區',
    getAdminFinancialSessionToken: () => 'qa-token',
    formatSupabaseError: error => error.message || String(error),
    isFinancialAdminSessionError: error => error?.message === 'Admin session invalid',
    isSupabaseAbortError: () => false,
    resetAutoRefreshTimer: () => {},
    logout: () => { calls.push({ name: 'logout' }); },
  });
  for (const [setter, field] of Object.entries({
    setEditingEmployee: 'editingEmployee', setEditingAutomationPlanId: 'editingAutomationPlanId',
    setEditingAutomationPlanTouched: 'editingAutomationPlanTouched', setEditingDispatchGroupId: 'editingDispatchGroupId',
    setCurrentDispatchGroup: 'currentDispatchGroup', setSavingEmployeeEdit: 'savingEmployeeEdit',
    setEditEmployeeError: 'editEmployeeError', setAutomationAssignmentsByEmployee: 'automationAssignmentsByEmployee',
    setNotification: 'notification', setLoadError: 'loadError', setLoading: 'loading', setIsRefreshing: 'isRefreshing',
    setRegions: 'regions', setAutomationPlans: 'automationPlans', setAdminPinOverrides: 'adminPinOverrides',
    setStatsLoading: 'statsLoading', setExpandedGroups: 'expandedGroups', setEmployeeGroups: 'employeeGroups',
  })) {
    context[setter] = value => {
      const next = typeof value === 'function' ? value(context[field] ?? (field === 'expandedGroups' ? new Set() : null)) : value;
      context[field] = next;
      setters.push({ field, value: next });
      if (field === 'employeeGroups') context.employeeGroupsRef.current = next;
    };
  }
  context.supabase = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'admin_update_employee_account') {
        if (failWrite) return { data: null, error: { message: 'QA account write failed' } };
        Object.assign(serverEmployee, args.p_updates);
        return { data: null, error: null };
      }
      if (name === 'admin_assign_dispatch_group_member') {
        if (failDispatch) return { data: null, error: { message: 'QA group write failed' } };
        return { data: { member: { group_id: args.p_group_id } }, error: null };
      }
      if (name === 'get_employee_management_snapshot') {
        const data = { admins: [admin], employees: [{ ...serverEmployee }], regions: [] };
        if (heldRead) {
          heldRead = false;
          return new Promise(resolve => pendingReads.push(() => resolve({ data, error: null })));
        }
        if (failRead) return { data: null, error: { message: 'QA read failed' } };
        if (invalidateRead && !invalidated) {
          invalidated = true;
          context.realtimeChangeGenerationRef.current += 1;
        }
        return { data, error: null };
      }
      if (name === 'get_notification_automation_plan_assignments') return { data: { plans: [], assignments: [] }, error: null };
      if (name === 'get_withdrawals_for_admin') return { data: [], error: null };
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  for (const name of ['schedulePendingReload', 'loadEmployees', 'guardedLoadEmployees']) {
    assert(functions.has(name));
    const code = ts.transpileModule(`globalThis.${name} = ${functions.get(name)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    runInContext(code, context);
  }
  const saveState = ['editingEmployee', 'savingEmployeeEdit', 'dispatchGroupsLoading', 'dispatchGroupsError',
    'editingDispatchGroupId', 'dispatchGroups', 'currentDispatchGroup', 'editingAutomationPlanId',
    'editingAutomationPlanTouched', 'automationAssignmentsByEmployee', 'automationPlans', 'regionNameById'];
  runInContext(ts.transpileModule(`globalThis.createSaveHandler = (${saveState.join(', ')}) => ${functions.get('handleSaveEmployeeEdit')};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  context.handleSaveEmployeeEdit = () => context.createSaveHandler(...saveState.map(name => context[name]))();
  context.guardedLoadEmployeesRef.current = context.guardedLoadEmployees;
  t.after(() => {
    context.isMountedRef.current = false;
    clearTimeout(context.pendingReloadTimerRef.current);
  });
  return {
    context, calls, setters, serverEmployee,
    holdNextRead() { heldRead = true; },
    releaseRead() { assert(pendingReads.length); pendingReads.shift()(); },
    allowDispatch() { failDispatch = false; },
    save: () => context.handleSaveEmployeeEdit(),
    refresh: () => context.guardedLoadEmployees(true),
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const waitForReload = () => new Promise(resolve => setTimeout(resolve, 850));
const writes = h => h.calls.filter(call => call.name.startsWith('admin_'));

test('confirmed save closes once, reports background refresh and writes only once', async t => {
  const h = harness(t);
  await h.save();
  await settle();
  assert.equal(h.serverEmployee.remarks, 'after');
  assert.equal(h.context.editingEmployee, null);
  assert.equal(h.context.editEmployeeError, null);
  assert.equal(h.context.notification.type, 'success');
  assert.match(h.context.notification.message, /背景更新/);
  assert.equal(writes(h).length, 1);
});

test('an in-flight old read is invalidated; save succeeds while the fresh read is queued', async t => {
  const h = harness(t);
  h.holdNextRead();
  const priorRead = h.refresh();
  assert.equal(h.context.loadInProgressRef.current, true);
  await h.save();
  assert.equal(h.context.notification.type, 'success');
  assert.equal(h.context.editingEmployee, null);
  assert.equal(h.context.pendingReloadRef.current, true);
  h.releaseRead();
  assert.equal(await priorRead, false);
  assert.equal(h.setters.filter(entry => entry.field === 'employeeGroups').length, 0);
  await waitForReload();
  assert.equal(h.context.employeeGroupsRef.current[0].employees[0].remarks, 'after');
  assert.equal(h.context.editEmployeeError, null);
  assert.equal(writes(h).length, 1);
});

test('a realtime-invalidated post-save read queues another read without requiring another save', async t => {
  const h = harness(t, { invalidateRead: true });
  await h.save();
  await settle();
  assert.equal(h.context.notification.type, 'success');
  assert.equal(h.context.editEmployeeError, null);
  assert.equal(h.setters.filter(entry => entry.field === 'employeeGroups').length, 0);
  await waitForReload();
  assert.equal(h.context.employeeGroupsRef.current[0].employees[0].remarks, 'after');
  assert.equal(writes(h).length, 1);
});

test('a real write failure keeps the editor and draft open and never reports success', async t => {
  const h = harness(t, { failWrite: true });
  await h.save();
  assert.equal(h.context.notification, null);
  assert.equal(h.context.editingEmployee.remarks, 'after');
  assert.equal(h.context.editingEmployeeInitialRef.current.remarks, 'before');
  assert.match(h.context.editEmployeeError, /帳戶資料儲存失敗.*QA account write failed/);
  assert.equal(h.serverEmployee.remarks, 'before');
  assert.equal(h.context.savingEmployeeEdit, false);
});

test('partial success retains the unfinished group change and retry never resubmits the saved account', async t => {
  const h = harness(t, { dispatchChanged: true, failDispatch: true });
  await h.save();
  assert.match(h.context.editEmployeeError, /帳戶資料已儲存；派單分組儲存失敗/);
  assert.equal(h.context.editingEmployeeInitialRef.current.remarks, 'after');
  assert.equal(h.context.notification, null);
  h.allowDispatch();
  await h.save();
  await settle();
  assert.equal(h.context.notification.type, 'success');
  assert.equal(h.calls.filter(call => call.name === 'admin_update_employee_account').length, 1);
  assert.equal(h.calls.filter(call => call.name === 'admin_assign_dispatch_group_member').length, 2);
});

test('a confirmed write followed by a real read failure reports the list error separately', async t => {
  const h = harness(t, { failRead: true });
  await h.save();
  await settle();
  assert.equal(h.serverEmployee.remarks, 'after');
  assert.equal(h.context.notification.type, 'success');
  assert.equal(h.context.editingEmployee, null);
  assert.equal(h.context.editEmployeeError, null);
  assert.match(h.context.loadError, /無法更新員工資料，目前顯示上次載入的內容/);
  assert.equal(h.context.employeeGroupsRef.current[0].employees[0].remarks, 'before');
  assert.equal(writes(h).length, 1);
});
