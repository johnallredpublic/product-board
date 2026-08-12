import { Routes } from '@angular/router';
import { BoardStore } from './board/board-store';
import { PersistService } from './board/persist.service';

export const routes: Routes = [
  { path: '', redirectTo: 'boards', pathMatch: 'full' },
  {
    path: 'boards',
    loadComponent: () =>
      import('./boards/board-list.component').then((m) => m.BoardListComponent),
  },
  {
    path: 'boards/:boardId',
    providers: [BoardStore, PersistService], // scoped to this route: one per board
    loadComponent: () =>
      import('./board/board-page.component').then((m) => m.BoardPageComponent),
  },
];
