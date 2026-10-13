# The brain view

This document specifies the brain view of the Graph window. The view draws the knowledge graph as the neurons of an anatomical human brain, divided into regions that are named after the categories of information they hold, and it shows how the neurons fire and connect through the regions when a prompt is handled, one step after another as the thinking proceeds.

## What the view shows

The view draws an anatomical human brain as one faint outer silhouette. Each node of the graph is a neuron placed in the region whose real function matches what the node is, so that rules and decisions are placed in the prefrontal cortex, memory files in the temporal lobe and hippocampus, and agents in the cerebellum. Every caption, label, legend entry and trail line on screen names the category, such as Rules and decisions or Agents. The anatomical name appears only as a second, smaller line in the legend. When Claude Code works on a prompt, the hooks report each step in order, and the view replays the steps one at a time as a numbered thought trail, with a pulse travelling along each link from the node that caused a firing to the node it fired.

The force layout stays available as the Network layout, which is chosen in the Graph window, and the brain is the default.

## The brain model

The model is the 3D Reference Organ for Brain, Male, version 1.4, of the HuBMAP Human Reference Atlas, derived from the Allen Human Brain Atlas (Ding et al. 2016). It is licensed under CC BY 4.0, and the citation that ships in the About window and in `NOTICE` is 'Browne, Kristen, and Heidi Schlehlein. 2024. 3D Reference Organ for Brain, Male v1.4. https://doi.org/10.48539/HBM538.NKCT.649', followed by the statement that Ranviera simplified the meshes, grouped them into regions and recoloured them.

| Fact | Value |
|---|---|
| Source file | `https://cdn.humanatlas.io/digital-objects/ref-organ/brain-male/v1.4/assets/3d-allen-m-brain.glb` |
| SHA-256 of the source | `c97d7d0b9ff0baebbdec5566fa7b08d789195ef965e0bd04cf743a8d683882db` |
| Size and content | 11,982,812 bytes, 283 meshes, 656,268 triangles, no textures |
| Coordinates | metres, Y up, anterior is +Z, names ending `_L` lie at negative X in the source, which makes the source a mirror image. `brain.glb` and `brain-points.bin` are mirrored to true handedness (X negated, winding reversed), so in them the left hemisphere and the language region lie at positive X, in units with the brain centred on the origin and 200 across |

The script `scripts/brain/build-brain-asset.mjs` downloads the source into a cache folder that is not committed, checks the SHA-256, and writes the committed files that the web app loads, with `NOTICE.txt` beside them:

- `web/public/brain/brain.glb`, with one mesh for each region and hemisphere and one shell mesh for the cortex that holds no nodes, re-centred, scaled so that the brain spans 200 units, simplified and compressed with meshopt, at no more than 3 MB
- `web/public/brain/brain-points.bin`, little-endian Float32 values in groups of 6 (x, y, z and the surface normal), at least 6,000 points for each cortical region and 1,500 for each deep region, in the coordinates of `brain.glb`
- `web/public/brain/brain-regions.json`, with the version, the source, the licence, the citation and, for each region and hemisphere, its triangle count, centroid, a label anchor outside the surface and the offset and count of its points in `brain-points.bin`.

The source names 3 meshes that do not match their positions. `frontal_pole` is a deep strip in the temporo-occipital white matter and is not drawn, `frontomarginal_gyrus` lies on the medial temporal base, and `posteroventral_putamen` is the dorsal cingulate arc. `scripts/brain/regions.json` records the reason for each, and the hemisphere of each mesh comes from its name.

The script reads the grouping of meshes into regions from `scripts/brain/regions.json`, so that the grouping is data and is tested. The script is deterministic, so the same source gives the same output byte for byte. The white matter, the ventricles, the corpus callosum and the optic structures are not drawn.

## Regions

Each region has a name that states its category, a function taken from a published source, a set of meshes and the classes of node it holds. The anatomical name is the second line of its legend entry. The colour of each region is a token named `--color-region-<id>` in `web/src/index.css`. The token has a value for the light theme and a value for the dark theme. The 10 colours must stay distinct under the common forms of colour blindness, which the colour test checks with a deuteranopia and a protanopia simulation and a minimum difference between every pair.

| Id | Name shown | Region and function | Meshes (both hemispheres unless stated) | What Ranviera places there |
|---|---|---|---|---|
| `prefrontal` | Rules and decisions | Prefrontal cortex, where planning, reasoning and problem solving take place (Queensland Brain Institute, Lobes of the brain) | superior and middle frontal gyri, orbital gyri, gyrus rectus, rostral and paracingulate gyri, anterior cingulate gyrus (including the mesh named `posteroventral_putamen`, which is the dorsal arc of the cingulate gyrus), frontal operculum, and the right inferior frontal gyrus | instruction files, map files, rule files, skills, reference and guide files, sections, rules, path scopes and decisions, except those placed in the language or visual regions |
| `language` | Writing and vocabulary | Language areas of the left hemisphere, where Broca's area shapes speech and Wernicke's area supports understanding (NIDCD, Aphasia, March 2025) | left only: inferior frontal gyrus (triangular and opercular parts), planum temporale, superior temporal gyrus and Heschl's gyrus | concepts and concept schemes, the output style, and instruction nodes in the writing domain |
| `occipital` | Decks and visuals | Occipital lobe, the major visual processing centre (Queensland Brain Institute) | cuneus, lingual gyrus, occipital pole, superior and inferior occipital gyri, occipital part of the fusiform gyrus | templates and instruction nodes in the visual domain |
| `motor` | Tools and scripts | Primary motor cortex, the main region for voluntary movement (Queensland Brain Institute) | primary motor cortex, rostral paracentral lobule | tools, built-in tools and launch configurations |
| `parietal` | Projects and deliverables | Parietal lobe, which brings sensory information together (Queensland Brain Institute) | postcentral gyrus, superior parietal lobule, supramarginal and angular gyri, precuneus, caudal paracentral lobule, parietal operculum | projects, apps, deliverables, folders, backlog sections, open items, organisations, clients, people and instruments |
| `memory` | Memory and history | Temporal lobe and hippocampus, where memory is formed (Queensland Brain Institute, Limbic system) | middle and inferior temporal gyri, temporal pole, planum polare, the right superior temporal gyrus, planum temporale and Heschl's gyrus, parahippocampal gyri, temporal part of the fusiform gyrus, the mesh named `frontomarginal_gyrus` (which lies on the medial base of the temporal lobe), hippocampus (head, body and tail) and amygdala | memory files, record stores and history files |
| `basal` | Checks and gates | Basal ganglia, which select and start actions (Coizet and Ambroggi 2024) | caudate, putamen, globus pallidus, nucleus accumbens, subthalamic nucleus, substantia nigra | gates, fault checks and findings |
| `thalamus` | Task routing | Thalamus, which relays incoming signals to the cortex (Queensland Brain Institute, Forebrain) | thalamus and its nuclei | task types and routes |
| `cerebellum` | Agents | Cerebellum, which coordinates movement (Queensland Brain Institute, Hindbrain) | vermis, paravermis, lateral hemispheres, deep nuclei | agents |
| `brainstem` | Hooks and schedules | Brainstem, which runs vital functions such as breathing without conscious control (Queensland Brain Institute, Hindbrain) | pons, medulla, midbrain tegmentum, cerebral peduncles, colliculi, red nucleus | hooks and scheduled tasks |

An instruction node (a file, a section or a rule) takes its domain from the path of the file that contains it. The writing domain matches the words writ, voice, register, style, tone, prose and lexicon in the path, and the visual domain matches deck, slide, visual, chart, figure, poster, design and template. The lists are configurable as `brain_domains` in the configuration, and a node that matches neither list belongs to Rules and decisions. The mapping lives in `shared/brain.ts`, which both the server and the web app import, and a node of a class that the table does not name is placed in the prefrontal region and reported once in the console.

Within a region, nodes form clusters, one for each container. A cluster is the file that holds a rule or a section, the project that holds a deliverable, an open item or a backlog section, the type of a memory file, and the kind of a tool. Each cluster has a label at its centre, named after the container. The view shows region captions when the camera is far away and cluster labels when the camera is close to a region or a region is focused, so that the labels never crowd the screen.

Nodes are placed on both hemispheres, except in the Writing and vocabulary region. The nodes of one file stay together on one hemisphere, and files alternate between hemispheres in the order of their identifiers.

### The agent transparency classes (7 October 2026)

The classes of a deployed agent and of a bank's obligations, added for agent transparency, take the regions of the table below, which `shared/brain.ts` holds as `CLASS_REGION`.

| Region | Classes |
|---|---|
| `prefrontal` | InstructionVersion, PolicyClause, Mapping, AgentDecision, Obligation, PolicyException and Policy |
| `language` | StatedRationale, Typology and RiskIndicator |
| `motor` | ToolCall |
| `parietal` | LegislativeProvision and OrganisationalRole |
| `memory` | KnowledgeSource, Evidence and LedgerEntry |
| `basal` | Review, Sample, BackTest, TestScript, TestStep, Requirement, Control and ControlFramework |
| `cerebellum` | DeployedAgent, ModelVersion, Run and Step |

## Placement

Placement is deterministic, so that a rule appears in the same place from one session to the next and a person can learn where things are. Within a region, the placer groups nodes by the file that contains them, gives each group a seed point by farthest-point sampling over the region's sample points, and then gives each node of the group the nearest free sample point to the seed, in the order of the node identifiers. Cortical nodes are placed 1.5 units outside the surface along its normal, and nodes of the deep regions lie on the surface of their structure. If a region has more nodes than sample points, the placer reports it and reuses points with a small offset.

## Drawing

The brain surface is one faint outer silhouette with a soft rim and a light tint of each region, and the inner folds are not drawn as separate layers. The Surface control sets the opacity of the silhouette from hidden to solid, and its default is faint.

Neurons are drawn as one `THREE.Points` object with a round sprite shader. Each neuron is a bright core with a soft halo, at least 5 pixels across at the default distance and up to about 16 pixels for the hottest, in a saturated version of the colour of its region that has enough contrast with the background in both themes. Neurons are drawn over the surface, so that the surface never hides them, and those on the far side of the brain are dimmer, so that depth stays readable. A hovered neuron grows and shows its label.

The Expand control moves the regions apart from the centre of the brain, from 0 (the anatomical position) to 1 (the regions clearly separated), so that the deep regions (Task routing, Checks and gates, Agents, and Hooks and schedules) can be seen and reached.

Links are not drawn at rest. When a node is selected or hovered, its links are drawn as curves that bend towards the centre of the brain, in the manner of white matter tracts, and a link whose provenance is proposed is drawn dashed and only when the Graph window option 'Show links not yet reviewed' is on. A region that is firing raises its tint for the length of the step.

Bloom remains in use, with a threshold set so that only firing nodes and pulses bloom. The camera turns slowly when auto-rotate is on and nothing is selected, and it turns towards the active region at the start of each step. Where the operating system asks for reduced motion, the camera does not move, pulses are not drawn and each step lights its nodes at once.

## Labels

Text is drawn as HTML over the canvas, in Inter at the `text-caption` step or larger, with a dark outline drawn by text shadow and no box behind it. Region captions are shown at their label anchors when the camera is far away, with the category name and, on hover, the function and the number of nodes. Cluster labels replace them when the camera is close to a region or a region is focused. A labels switch turns the text on or off. Node labels are shown only for the selected node, the hovered node and the nodes of the current step, at most 14 at once, chosen in the order of their activation. A placement pass tries 8 positions around each point in priority order and drops a label that would overlap another, and each label keeps a thin leader line to its point when it is moved off it.

## The thought trail

The thought trail is a panel at the left edge of the canvas that lists the steps of the current prompt in order, each with its number, the colour of its region, a plain sentence and its time. It opens when the first step of a prompt arrives and closes only when the person closes it. It has these controls:

- Live, the default, which plays each step as its event arrives
- Replay last prompt, which plays the steps of the last prompt again at a chosen speed of half, normal or double
- Try a prompt, a text field that asks the server for a plan with `POST /api/plan` and plays the predicted spread without running anything.

Each event in the stream (`fire` messages, see `CONTRACTS.md`) becomes one step. The sentence comes from the event kind:

| Event kind | Sentence |
|---|---|
| `prompt` | Prompt received |
| `route` | Routed to the task type <label> |
| `instructions` | Loaded <file> |
| `read`, `write` | Read <file>, Wrote <file> |
| `skill` | Used the skill <label> |
| `agent.start`, `agent.stop` | Agent <label> started, Agent <label> finished |
| `tool` | Used the tool <label> |
| `check`, `fault` | Ran the check <label>, Found the fault <label> |
| `session.start`, `session.end` | Session started, Session ended |
| `mission.start`, `mission.step`, `mission.end` | Mission started, Mission step <n>, Mission finished |

A step lights its fired nodes (hop 0) first. Each node of hop 1 then lights after 250 milliseconds with a pulse from the node named in its `via`, and each node of hop 2 after another 250 milliseconds. A step lasts at least 900 milliseconds. Steps queue, and when more than 8 are waiting the queue plays at double speed and the panel says that it is catching up.

Steps from the stream are marked Observed. Steps from Try a prompt are marked Predicted, drawn with a softer glow and a dashed ring, and never recorded. To support them, `POST /api/plan` returns `spread`, the activation of the plan with its hops and its `via` nodes, in the shape of the stream's `activation`.

## Interaction and navigation

Clicking a node selects it and opens it in the Inspector. Double-clicking a neuron selects it and moves the camera to it, as a search result does. The legend in the Graph window lists the 10 regions with their colour, category name, anatomical name, contents and node count, and each region can be hidden. Clicking or double-clicking a region caption, a cluster label or a region in the legend focuses that region. The camera moves to it, the other regions fade to about 15 per cent, its cluster labels appear and its 10 hottest nodes are listed in the Graph window. Escape or the reset control ends the focus.

- Dragging with the left button turns the brain with damping, dragging with the right button pans, and the wheel zooms towards the pointer.
- A control group at the bottom right of the canvas holds zoom in, zoom out, reset view, the 4 preset views (left, right, top and front), auto-rotate on or off, the Surface and Expand controls and the labels switch. Each control has a text label or a tooltip, and the group works with the keyboard.
- The keyboard turns the brain with the arrow keys, zooms with plus and minus, resets with 0, chooses the preset views with 1 to 4 and clears a focus with Escape.

## Checks

The brain view is finished when all of these hold:

- the unit tests pass for the mapping of every class to a region, for deterministic placement (the same graph gives the same positions), for the label placement pass (no 2 shown labels overlap) and for the timing of the step queue
- the asset script reproduces `brain.glb` and `brain-regions.json` byte for byte from the source
- the view draws at 50 frames a second or more with a graph of about 2,200 nodes, measured with `measureFps`
- the unit tests pass for the category names of all 10 regions, the cluster key of every class, the expanded positions and the level of detail of the labels
- the smoke test photographs the brain at rest, focused on 2 regions, expanded, with the surface hidden, during a step with labels, with the thought trail open, in the light and dark themes and at 1,280 and 1,920 pixels wide, and each photograph has been looked at, so that the neurons are clearly visible and the captions are named by category
- the console is clean and the type check, lint and build pass.

## Changes to this document

- 6 October 2026: first public version, written from the project's internal specification.
- 6 October 2026 (later): regions named by category, clusters with labels, a fainter surface, larger neurons, the Expand and Surface controls and the navigation controls.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.
