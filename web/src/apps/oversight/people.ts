import { createContext, useContext } from "react";
import type { OversightStatus } from "@shared/types";

/** The people file, so that every part of the Oversight window can show a name where the record holds an identifier. */
export const PeopleContext = createContext<OversightStatus["people"]>([]);

export const usePeople = () => useContext(PeopleContext);
