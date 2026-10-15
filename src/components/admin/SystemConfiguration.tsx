import { Admin } from '../../types';
import AdminGroupConfiguration from './AdminGroupConfiguration';
import SecondaryAdminConfiguration from './SecondaryAdminConfiguration';

interface SystemConfigurationProps {
  admin: Admin;
  isActive: boolean;
}

export default function SystemConfiguration({ admin, isActive }: SystemConfigurationProps) {
  if (admin.role === 'super_admin') {
    return <AdminGroupConfiguration isActive={isActive} />;
  }

  return <SecondaryAdminConfiguration admin={admin} />;
}
