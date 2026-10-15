import PageLoader from './PageLoader';

export default function EmployeeBootScreen({ exiting = false }: { exiting?: boolean }) {
  return (
    <div className={`emp-boot ${exiting ? 'emp-boot-exit' : ''}`}>
      <PageLoader className="!min-h-0" />
    </div>
  );
}
