import { createContext, useContext } from 'react';

// A screen with unsaved edits calls setDirty(true). The shell (App.jsx) then asks before any move to another screen,
// and the screen itself warns on a page reload (beforeunload). setDirty(false) on unmount clears it.
export const NavGuardCtx = createContext({ setDirty: () => {} });
export const useNavGuard = () => useContext(NavGuardCtx);
