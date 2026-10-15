import { useState, useEffect, useCallback } from 'react';
import { Clock, Plus, Trash2, ChevronRight, Pencil, Save, X, CheckCircle, XCircle, Settings, Search } from 'lucide-react';
import { Admin } from '../../types';
import { supabase } from '../../lib/supabase';

interface SubmitTimeManagementProps {
  admin: Admin;
}

interface TimeGroup {
  id: string;
  admin_id: string;
  name: string;
  min_seconds: number;
  max_seconds: number;
}

interface Employee {
  id: string;
  username: string;
  employee_id: string;
  created_by: string;
}

interface Assignment {
  user_id: string;
  group_id: string;
}

interface AdminData {
  admin_id: string;
  admin_username: string;
  admin_role: string;
  defaultMin: number;
  defaultMax: number;
  groups: TimeGroup[];
  employees: Employee[];
  assignments: Assignment[];
}

export default function SubmitTimeManagement({ admin }: SubmitTimeManagementProps) {
  const [adminsData, setAdminsData] = useState<AdminData[]>([]);
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [showAddPanel, setShowAddPanel] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState({ name: '', min_seconds: '5', max_seconds: '20' });
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', min_seconds: '', max_seconds: '' });
  const [editingDefault, setEditingDefault] = useState<string | null>(null);
  const [defaultForm, setDefaultForm] = useState({ min: '5', max: '20' });
  const [expandedAdmin, setExpandedAdmin] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      let adminIds: string[] = [];
      const adminMap: Record<string, { username: string; role: string }> = {};

      if (admin.role === 'super_admin') {
        const { data: admins } = await supabase
          .from('admins').select('id, username, role')
          .in('role', ['super_admin', 'secondary_admin']).neq('role', 'emergency_admin');
        if (admins) {
          adminIds = admins.map(a => a.id);
          admins.forEach(a => { adminMap[a.id] = { username: a.username, role: a.role }; });
        }
      } else {
        adminIds = [admin.id];
        adminMap[admin.id] = { username: admin.username, role: admin.role };
      }

      const { data: configs } = await supabase
        .from('admin_configs').select('admin_id, config_type, config_value')
        .in('config_type', ['order_submit_time_min', 'order_submit_time_max']);

      const globalConfigs: Record<string, string> = {};
      const perAdmin: Record<string, Record<string, string>> = {};
      configs?.forEach(c => {
        if (!c.admin_id) globalConfigs[c.config_type] = c.config_value;
        else { if (!perAdmin[c.admin_id]) perAdmin[c.admin_id] = {}; perAdmin[c.admin_id][c.config_type] = c.config_value; }
      });
      const gMin = parseInt(globalConfigs.order_submit_time_min || '5');
      const gMax = parseInt(globalConfigs.order_submit_time_max || '20');

      const { data: groups } = await supabase
        .from('submit_time_groups').select('*').in('admin_id', adminIds).order('created_at', { ascending: true });

      const { data: employees } = await supabase
        .from('users').select('id, username, employee_id, created_by')
        .in('created_by', adminIds).eq('is_active', true).order('username', { ascending: true });

      const empIds = employees?.map(e => e.id) || [];
      let assignments: Assignment[] = [];
      if (empIds.length > 0) {
        const { data } = await supabase
          .from('employee_submit_time_settings').select('user_id, group_id')
          .in('user_id', empIds).not('group_id', 'is', null);
        assignments = (data || []) as Assignment[];
      }

      const result: AdminData[] = adminIds.map(aid => {
        const info = adminMap[aid] || { username: 'Unknown', role: 'secondary_admin' };
        const ac = perAdmin[aid] || {};
        const adminEmps = (employees || []).filter(e => e.created_by === aid);
        return {
          admin_id: aid,
          admin_username: info.username,
          admin_role: info.role,
          defaultMin: parseInt(ac.order_submit_time_min || '') || gMin,
          defaultMax: parseInt(ac.order_submit_time_max || '') || gMax,
          groups: (groups || []).filter(g => g.admin_id === aid),
          employees: adminEmps,
          assignments: assignments.filter(a => adminEmps.some(e => e.id === a.user_id)),
        };
      });

      result.sort((a, b) => {
        if (a.admin_role === 'super_admin' && b.admin_role !== 'super_admin') return -1;
        if (b.admin_role === 'super_admin' && a.admin_role !== 'super_admin') return 1;
        return a.admin_username.localeCompare(b.admin_username);
      });

      setAdminsData(result);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [admin]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { if (notification) { const t = setTimeout(() => setNotification(null), 2500); return () => clearTimeout(t); } }, [notification]);

  const notify = (type: 'success' | 'error', message: string) => setNotification({ type, message });

  const assignToGroup = async (userId: string, groupId: string, adminId: string) => {
    setAdminsData(prev => prev.map(ad => {
      if (ad.admin_id !== adminId) return ad;
      const newAssignments = ad.assignments.filter(a => a.user_id !== userId);
      newAssignments.push({ user_id: userId, group_id: groupId });
      return { ...ad, assignments: newAssignments };
    }));

    const { data: existing } = await supabase
      .from('employee_submit_time_settings').select('id').eq('user_id', userId).maybeSingle();
    if (existing) {
      await supabase.from('employee_submit_time_settings')
        .update({ group_id: groupId, min_seconds: null, max_seconds: null }).eq('user_id', userId);
    } else {
      await supabase.from('employee_submit_time_settings')
        .insert({ user_id: userId, group_id: groupId });
    }
  };

  const removeFromGroup = async (userId: string, adminId: string) => {
    setAdminsData(prev => prev.map(ad => {
      if (ad.admin_id !== adminId) return ad;
      return { ...ad, assignments: ad.assignments.filter(a => a.user_id !== userId) };
    }));
    await supabase.from('employee_submit_time_settings').delete().eq('user_id', userId);
  };

  const handleSaveDefault = async (adminId: string) => {
    const min = parseInt(defaultForm.min);
    const max = parseInt(defaultForm.max);
    if (isNaN(min) || isNaN(max) || min > max || min < 3 || max < 3 || max > 300) { notify('error', 'Invalid range (3-300s)'); return; }
    for (const [type, val] of [['order_submit_time_min', min], ['order_submit_time_max', max]] as const) {
      const { data: existing } = await supabase.from('admin_configs').select('id').eq('admin_id', adminId).eq('config_type', type).maybeSingle();
      if (existing) await supabase.from('admin_configs').update({ config_value: String(val) }).eq('id', existing.id);
      else await supabase.from('admin_configs').insert({ admin_id: adminId, config_type: type, config_value: String(val) });
    }
    notify('success', 'Default updated');
    setEditingDefault(null);
    await loadData();
  };

  const handleCreateGroup = async (adminId: string) => {
    const min = parseInt(newGroup.min_seconds);
    const max = parseInt(newGroup.max_seconds);
    if (!newGroup.name.trim()) { notify('error', 'Name is required'); return; }
    if (isNaN(min) || min < 3 || min > 120) { notify('error', 'Min must be 3-120 seconds'); return; }
    if (isNaN(max) || max < 3 || max > 300) { notify('error', 'Max must be 3-300 seconds'); return; }
    if (min > max) { notify('error', 'Min must be less than Max'); return; }
    const { error } = await supabase.from('submit_time_groups').insert({ admin_id: adminId, name: newGroup.name.trim(), min_seconds: min, max_seconds: max });
    if (error) { notify('error', error.message); return; }
    notify('success', 'Group created');
    setCreatingFor(null);
    setNewGroup({ name: '', min_seconds: '5', max_seconds: '20' });
    await loadData();
  };

  const handleUpdateGroup = async (groupId: string) => {
    const min = parseInt(editForm.min_seconds);
    const max = parseInt(editForm.max_seconds);
    if (!editForm.name.trim()) { notify('error', 'Name is required'); return; }
    if (isNaN(min) || min < 3 || min > 120) { notify('error', 'Min must be 3-120 seconds'); return; }
    if (isNaN(max) || max < 3 || max > 300) { notify('error', 'Max must be 3-300 seconds'); return; }
    if (min > max) { notify('error', 'Min must be less than Max'); return; }
    const { error } = await supabase.from('submit_time_groups').update({ name: editForm.name.trim(), min_seconds: min, max_seconds: max }).eq('id', groupId);
    if (error) { notify('error', error.message); return; }
    notify('success', 'Updated');
    setEditingGroup(null);
    await loadData();
  };

  const handleDeleteGroup = async (groupId: string) => {
    await supabase.from('submit_time_groups').delete().eq('id', groupId);
    if (expandedGroup === groupId) setExpandedGroup(null);
    notify('success', 'Deleted');
    await loadData();
  };

  const toggleGroup = (groupId: string) => {
    if (expandedGroup === groupId) {
      setExpandedGroup(null);
      setShowAddPanel(null);
    } else {
      setExpandedGroup(groupId);
      setShowAddPanel(null);
    }
    setSearchQuery('');
  };

  const renderGroupContent = (data: AdminData, groupId: string, members: Employee[], isDefault: boolean) => {
    const canEdit = admin.role === 'super_admin' || data.admin_id === admin.id;
    const isAdding = showAddPanel === groupId;

    // For default group: available = employees in custom groups (move them back)
    // For custom groups: available = employees not in THIS group
    const getAvailableEmployees = () => {
      return data.employees.filter(e => {
        if (isDefault) {
          const hasAssignment = data.assignments.some(a => a.user_id === e.id);
          if (!hasAssignment) return false;
        } else {
          const currentAssign = data.assignments.find(a => a.user_id === e.id);
          if (currentAssign?.group_id === groupId) return false;
        }
        if (!searchQuery) return true;
        return e.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
               e.employee_id.toLowerCase().includes(searchQuery.toLowerCase());
      });
    };

    const handleAddClick = (emp: Employee) => {
      if (isDefault) {
        removeFromGroup(emp.id, data.admin_id);
      } else {
        assignToGroup(emp.id, groupId, data.admin_id);
      }
    };

    return (
      <div className="border-t border-slate-700/30">
        {/* Members Section */}
        <div className="p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Members ({members.length})
            </span>
            {canEdit && (
              <button
                onClick={() => { setShowAddPanel(isAdding ? null : groupId); setSearchQuery(''); }}
                className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md transition-colors ${
                  isAdding
                    ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40'
                    : 'bg-slate-700/50 text-slate-300 hover:bg-blue-600/20 hover:text-blue-300 border border-slate-600/50 hover:border-blue-500/30'
                }`}>
                <Plus className="w-3 h-3" />
                Add
              </button>
            )}
          </div>

          {members.length === 0 ? (
            <p className="text-xs text-slate-500 italic py-2">
              {isDefault ? 'All employees have been assigned to custom groups' : 'No employees assigned yet'}
            </p>
          ) : (
            <div className="space-y-px max-h-48 overflow-y-auto">
              {members.map((emp, idx) => (
                <div key={emp.id} className={`flex items-center justify-between py-1.5 px-2 rounded ${idx % 2 === 0 ? 'bg-slate-800/30' : ''}`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xs text-slate-500 w-5 text-right">{idx + 1}</span>
                    <span className="text-sm text-white truncate">{emp.username}</span>
                    <span className="text-[11px] text-slate-500 font-mono">{emp.employee_id}</span>
                  </div>
                  {canEdit && !isDefault && (
                    <button onClick={() => removeFromGroup(emp.id, data.admin_id)}
                      className="shrink-0 px-2 py-0.5 text-[11px] text-red-400/70 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors">
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add Employee Panel - visually distinct */}
        {isAdding && canEdit && (
          <div className="mx-3 mb-3 bg-slate-900/80 rounded-lg border border-blue-500/25 overflow-hidden">
            <div className="px-3 py-2 bg-blue-500/5 border-b border-blue-500/15 flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-blue-400" />
              <input
                type="text"
                placeholder={isDefault ? "Search employees in custom groups..." : "Search all employees..."}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 outline-none"
                autoFocus
              />
              <button onClick={() => setShowAddPanel(null)} className="p-0.5 text-slate-400 hover:text-white">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="p-2 max-h-40 overflow-y-auto">
              {(() => {
                const available = getAvailableEmployees();
                if (available.length === 0) {
                  return <p className="text-xs text-slate-500 text-center py-2">
                    {isDefault ? 'No employees in custom groups' : 'No employees available'}
                  </p>;
                }
                return available.map(emp => {
                  const currentAssign = data.assignments.find(a => a.user_id === emp.id);
                  const fromGroup = currentAssign ? data.groups.find(g => g.id === currentAssign.group_id) : null;
                  return (
                    <button key={emp.id}
                      onClick={() => handleAddClick(emp)}
                      className="w-full flex items-center justify-between py-1.5 px-2 rounded hover:bg-blue-500/10 transition-colors text-left">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm text-white truncate">{emp.username}</span>
                        <span className="text-[11px] text-slate-500 font-mono shrink-0">{emp.employee_id}</span>
                      </div>
                      {fromGroup ? (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded border border-amber-500/20">
                          {fromGroup.name}
                        </span>
                      ) : (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-slate-700/50 text-slate-400 rounded">
                          Default
                        </span>
                      )}
                    </button>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderAdminSection = (data: AdminData) => {
    const canEdit = admin.role === 'super_admin' || data.admin_id === admin.id;
    const unassigned = data.employees.filter(e => !data.assignments.some(a => a.user_id === e.id));
    const defaultGroupId = `default-${data.admin_id}`;
    const isDefaultExpanded = expandedGroup === defaultGroupId;

    return (
      <div className="space-y-1">
        {/* Section header */}
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Groups</span>
          {canEdit && (
            <button onClick={() => { setCreatingFor(data.admin_id); setNewGroup({ name: '', min_seconds: '5', max_seconds: '20' }); }}
              className="flex items-center gap-1 px-2.5 py-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-xs font-medium rounded-lg border border-blue-500/30 transition-colors">
              <Plus className="w-3 h-3" /> New Group
            </button>
          )}
        </div>

        {/* Create form */}
        {creatingFor === data.admin_id && (
          <div className="flex items-center gap-2 p-3 bg-slate-800/50 rounded-lg border border-blue-500/20 mb-2">
            <input type="text" placeholder="Name" value={newGroup.name}
              onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
              className="flex-1 min-w-0 px-2.5 py-1.5 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
            <input type="number" min="3" max="120" placeholder="3-120" value={newGroup.min_seconds}
              onChange={(e) => setNewGroup({ ...newGroup, min_seconds: e.target.value })}
              className="w-16 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-white text-sm text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
            <span className="text-slate-500 text-xs">-</span>
            <input type="number" min="3" max="300" placeholder="3-300" value={newGroup.max_seconds}
              onChange={(e) => setNewGroup({ ...newGroup, max_seconds: e.target.value })}
              className="w-16 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-white text-sm text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
            <span className="text-slate-500 text-xs">sec</span>
            <button onClick={() => handleCreateGroup(data.admin_id)}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors">Create</button>
            <button onClick={() => setCreatingFor(null)} className="p-1 text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
        )}

        {/* Default Group Row */}
        <div className={`rounded-lg border transition-colors overflow-hidden ${isDefaultExpanded ? 'border-green-500/30 bg-slate-800/40' : 'border-slate-700/40 bg-slate-800/20 hover:border-slate-600/60'}`}>
          <div className="flex items-center px-3 py-2.5">
            <button onClick={() => toggleGroup(defaultGroupId)} className="p-0.5 text-slate-400 hover:text-white transition-colors mr-2">
              <ChevronRight className={`w-4 h-4 transition-transform ${isDefaultExpanded ? 'rotate-90' : ''}`} />
            </button>
            <button onClick={() => toggleGroup(defaultGroupId)} className="flex-1 flex items-center gap-3 text-left min-w-0">
              <Settings className="w-3.5 h-3.5 text-green-400 shrink-0" />
              <span className="text-white font-medium text-sm">Default</span>
              <span className="text-slate-500 text-xs">{unassigned.length} employees</span>
            </button>
            {editingDefault === data.admin_id ? (
              <div className="flex items-center gap-1.5 shrink-0">
                <input type="number" min="3" max="120" value={defaultForm.min}
                  onChange={(e) => setDefaultForm({ ...defaultForm, min: e.target.value })}
                  className="w-14 px-1.5 py-1 bg-slate-700 border border-slate-600 rounded text-white text-xs text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
                <span className="text-slate-500 text-xs">-</span>
                <input type="number" min="3" max="300" value={defaultForm.max}
                  onChange={(e) => setDefaultForm({ ...defaultForm, max: e.target.value })}
                  className="w-14 px-1.5 py-1 bg-slate-700 border border-slate-600 rounded text-white text-xs text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
                <span className="text-slate-500 text-[10px]">sec</span>
                <button onClick={() => handleSaveDefault(data.admin_id)} className="p-1 text-green-400 hover:bg-green-500/20 rounded"><Save className="w-3.5 h-3.5" /></button>
                <button onClick={() => setEditingDefault(null)} className="p-1 text-slate-400 hover:bg-slate-600 rounded"><X className="w-3.5 h-3.5" /></button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="px-2 py-0.5 bg-green-500/10 text-green-300 text-xs font-semibold rounded border border-green-500/20">
                  {data.defaultMin}-{data.defaultMax}s
                </span>
                {canEdit && (
                  <button onClick={() => { setEditingDefault(data.admin_id); setDefaultForm({ min: String(data.defaultMin), max: String(data.defaultMax) }); }}
                    className="p-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
          </div>
          {isDefaultExpanded && renderGroupContent(data, defaultGroupId, unassigned, true)}
        </div>

        {/* Custom Groups */}
        {data.groups.map(group => {
          const groupEmps = data.employees.filter(e => data.assignments.some(a => a.user_id === e.id && a.group_id === group.id));
          const isExpanded = expandedGroup === group.id;
          const isEditing = editingGroup === group.id;

          return (
            <div key={group.id} className={`rounded-lg border transition-colors overflow-hidden ${isExpanded ? 'border-blue-500/30 bg-slate-800/40' : 'border-slate-700/40 bg-slate-800/20 hover:border-slate-600/60'}`}>
              <div className="flex items-center px-3 py-2.5">
                <button onClick={() => toggleGroup(group.id)} className="p-0.5 text-slate-400 hover:text-white transition-colors mr-2">
                  <ChevronRight className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                </button>

                {isEditing ? (
                  <div className="flex-1 flex items-center gap-2">
                    <input type="text" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className="w-28 px-2 py-1 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <input type="number" min="3" value={editForm.min_seconds} onChange={(e) => setEditForm({ ...editForm, min_seconds: e.target.value })}
                      className="w-14 px-2 py-1 bg-slate-700 border border-slate-600 rounded text-white text-sm text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <span className="text-slate-500">-</span>
                    <input type="number" min="5" value={editForm.max_seconds} onChange={(e) => setEditForm({ ...editForm, max_seconds: e.target.value })}
                      className="w-14 px-2 py-1 bg-slate-700 border border-slate-600 rounded text-white text-sm text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <span className="text-slate-500 text-xs">sec</span>
                    <button onClick={() => handleUpdateGroup(group.id)} className="px-2 py-1 bg-green-600 text-white text-xs rounded">Save</button>
                    <button onClick={() => setEditingGroup(null)} className="px-2 py-1 bg-slate-600 text-white text-xs rounded">Cancel</button>
                  </div>
                ) : (
                  <>
                    <button onClick={() => toggleGroup(group.id)} className="flex-1 flex items-center gap-3 text-left min-w-0">
                      <Clock className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                      <span className="text-white font-medium text-sm truncate">{group.name}</span>
                      <span className="text-slate-500 text-xs">{groupEmps.length} employees</span>
                    </button>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="px-2 py-0.5 bg-blue-500/10 text-blue-300 text-xs font-semibold rounded border border-blue-500/20">
                        {group.min_seconds}-{group.max_seconds}s
                      </span>
                      {canEdit && (
                        <>
                          <button onClick={() => { setEditingGroup(group.id); setEditForm({ name: group.name, min_seconds: String(group.min_seconds), max_seconds: String(group.max_seconds) }); }}
                            className="p-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button onClick={() => handleDeleteGroup(group.id)}
                            className="p-1 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
              {isExpanded && !isEditing && renderGroupContent(data, group.id, groupEmps, false)}
            </div>
          );
        })}

        {data.groups.length === 0 && !creatingFor && (
          <p className="text-xs text-slate-500 text-center py-3">No custom groups. Click "New Group" to create one.</p>
        )}
      </div>
    );
  };

  if (loading) {
    return <div className="bg-slate-900/80 backdrop-blur-xl rounded-2xl border border-blue-500/20 p-8 text-center text-slate-400">Loading...</div>;
  }

  const isSuperAdmin = admin.role === 'super_admin';

  return (
    <div className="space-y-4">
      {notification && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-2xl border backdrop-blur-xl text-sm font-medium ${
          notification.type === 'success' ? 'bg-green-900/90 border-green-500/50 text-green-100' : 'bg-red-900/90 border-red-500/50 text-red-100'
        }`}>
          {notification.type === 'success' ? <CheckCircle className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
          {notification.message}
        </div>
      )}

      {/* Content */}
      {isSuperAdmin ? (
        adminsData.map(data => {
          const isSelf = data.admin_role === 'super_admin';
          const isExp = expandedAdmin === data.admin_id;
          return (
            <div key={data.admin_id} className={`bg-slate-900/80 backdrop-blur-xl rounded-2xl border overflow-hidden ${isSelf ? 'border-amber-500/30' : 'border-slate-700/40'}`}>
              <button onClick={() => setExpandedAdmin(isExp ? null : data.admin_id)}
                className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-slate-800/40 transition-colors">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${isSelf ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-blue-500/15 text-blue-300 border border-blue-500/20'}`}>
                    {data.admin_username.charAt(0).toUpperCase()}
                  </div>
                  <div className="text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium text-sm">{data.admin_username}</span>
                      {isSelf && <span className="px-1 py-0.5 bg-amber-500/20 text-amber-400 text-[9px] font-bold rounded border border-amber-500/30">SUPER</span>}
                    </div>
                    <span className="text-xs text-slate-500">{data.employees.length} emp | {data.groups.length} groups | Default: {data.defaultMin}-{data.defaultMax}s</span>
                  </div>
                </div>
                <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${isExp ? 'rotate-90' : ''}`} />
              </button>
              {isExp && (
                <div className="px-5 pb-5 border-t border-slate-700/40 pt-4">
                  {renderAdminSection(data)}
                </div>
              )}
            </div>
          );
        })
      ) : (
        adminsData.length > 0 && (
          <div className="bg-slate-900/80 backdrop-blur-xl rounded-2xl border border-blue-500/20 p-5">
            {renderAdminSection(adminsData[0])}
          </div>
        )
      )}
    </div>
  );
}
