import './globals.css';

export const metadata = {
  title: 'Lebur — confidential batch auction on Curve',
  description:
    'Sealed orders net inside a TEE. Only the clearing price and the aggregate residual ' +
    'ever become public, and the residual settles on an unmodified Curve pool.',
};

// Declared so the browser never flashes a light default before the stylesheet
// lands, and so native form controls render dark instead of system-white.
export const viewport = { themeColor: '#020617', colorScheme: 'dark' as const };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
