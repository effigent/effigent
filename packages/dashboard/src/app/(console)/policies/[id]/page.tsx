import { redirect } from 'next/navigation';

// The control plane serves one versioned endpoint policy per workspace, so
// there are no per-policy pages any more; old links land on the editor.
export default function PolicyPage() {
  redirect('/policies');
}
