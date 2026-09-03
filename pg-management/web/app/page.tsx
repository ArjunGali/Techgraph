'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** The launch route sends the user straight to the dashboard. */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);
  return null;
}
