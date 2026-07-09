import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import '../theme.css';

export const metadata: Metadata = {
  title: 'Effigent — Dashboard',
  description: 'Agent optimization dashboard.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        {/* apply the saved theme before first paint — avoids a flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: "try{var t=localStorage.getItem('effigent-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}",
          }}
        />
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
