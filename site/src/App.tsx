import ClickSpark from './components/reactbits/ClickSpark';
import Ambient from './sections/Ambient';
import Nav from './sections/Nav';
import Hero from './sections/Hero';
import Works from './sections/Works';
import Triage from './sections/Triage';
import Agent from './sections/Agent';
import How from './sections/How';
import Features from './sections/Features';
import Pricing from './sections/Pricing';
import Manifesto from './sections/Manifesto';
import Footer from './sections/Footer';

export default function App() {
  return (
    <ClickSpark sparkColor={['#3fe8b8', '#b89cff', '#f9a28c']} sparkSize={9} sparkRadius={20} sparkCount={9} duration={450}>
      <div className="relative min-h-screen overflow-x-clip">
        <Ambient />
        <Nav />
        <main>
          <Hero />
          <Works />
          <Triage />
          <Agent />
          <How />
          <Features />
          <Pricing />
          <Manifesto />
        </main>
        <Footer />
      </div>
    </ClickSpark>
  );
}
