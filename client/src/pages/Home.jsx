function Home({ user, onLogout }) {
  return (
    <div className="home-page">
      <header className="header">
        <h1>Admiral Undersea</h1>
        <div className="user-info">
          <span>Welcome, {user.username}</span>
          <button onClick={onLogout} className="logout-btn">Logout</button>
        </div>
      </header>

      <main className="main-content">
        <div className="game-options">
          <div className="option-card">
            <h2>Create Game</h2>
            <p>Start a new game and invite friends to join</p>
            <button className="primary-btn">Create</button>
          </div>

          <div className="option-card">
            <h2>Join Game</h2>
            <p>Enter a game code to join an existing game</p>
            <button className="primary-btn">Join</button>
          </div>
        </div>
      </main>
    </div>
  )
}

export default Home
