/**
 * Where a signed-in USER lands on the retired web app. One line, deliberately:
 * there is nothing else here for them to do, and a page that looked like an
 * app would invite them to try. proxy.ts is what sends people here.
 */
export const metadata = { title: "Baylo is on Android" }

export default function AndroidPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontSize: 18,
        textAlign: "center",
      }}
    >
      <p>Baylo is on Android — open the app on your phone.</p>
    </main>
  )
}
