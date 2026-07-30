import './globals.css';

export const metadata = {
  title: 'Lebur — confidential batch auction on Curve',
  description:
    'Sealed orders net inside a TEE. Only the clearing price and the aggregate residual ' +
    'ever become public, and the residual settles on an unmodified Curve pool.',
};

// Declared so the browser chrome matches the cream canvas and native form
// controls render light rather than inheriting a dark system preference.
export const viewport = { themeColor: '#fffdf5', colorScheme: 'light' as const };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
