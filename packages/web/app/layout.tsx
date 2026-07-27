export const metadata = {
  title: 'Lebur — confidential batch auction on Curve',
  description:
    'Sealed orders net inside a TEE. Only the clearing price and the aggregate residual ever become public.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#fbfcfe' }}>{children}</body>
    </html>
  );
}
