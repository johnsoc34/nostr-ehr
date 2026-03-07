import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Patient Portal | NostrEHR",
  description: "Secure access to your child's health records",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
